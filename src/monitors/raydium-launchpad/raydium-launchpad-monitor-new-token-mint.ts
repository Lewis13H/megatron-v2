import "dotenv/config";
import Client, {
  CommitmentLevel,
  SubscribeRequestAccountsDataSlice,
  SubscribeRequestFilterAccounts,
  SubscribeRequestFilterBlocks,
  SubscribeRequestFilterBlocksMeta,
  SubscribeRequestFilterEntry,
  SubscribeRequestFilterSlots,
  SubscribeRequestFilterTransactions,
} from "@triton-one/yellowstone-grpc";
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { SolanaParser } from "@shyft-to/solana-transaction-parser";
import { SubscribeRequestPing } from "@triton-one/yellowstone-grpc/dist/types/grpc/geyser";
import { TransactionFormatter } from "./utils/transaction-formatter";
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import raydiumLaunchpadIdl from "./idls/raydium_launchpad.json";
import { saveRaydiumToken } from "../../database/monitor-integration";

interface SubscribeRequest {
  accounts: { [key: string]: SubscribeRequestFilterAccounts };
  slots: { [key: string]: SubscribeRequestFilterSlots };
  transactions: { [key: string]: SubscribeRequestFilterTransactions };
  transactionsStatus: { [key: string]: SubscribeRequestFilterTransactions };
  blocks: { [key: string]: SubscribeRequestFilterBlocks };
  blocksMeta: { [key: string]: SubscribeRequestFilterBlocksMeta };
  entry: { [key: string]: SubscribeRequestFilterEntry };
  commitment?: CommitmentLevel | undefined;
  accountsDataSlice: SubscribeRequestAccountsDataSlice[];
  ping?: SubscribeRequestPing | undefined;
}

const TXN_FORMATTER = new TransactionFormatter();
const RAYDIUM_LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"
);
const RAYDIUM_LAUNCHPAD_IX_PARSER = new SolanaParser([]);
RAYDIUM_LAUNCHPAD_IX_PARSER.addParserFromIdl(
  RAYDIUM_LAUNCHPAD_PROGRAM_ID.toBase58(),
  raydiumLaunchpadIdl as Idl
);

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("Starting Stream...")
  const stream = await client.subscribe();

  // Create `error` / `end` handler
  const streamClosed = new Promise<void>((resolve, reject) => {
    stream.on("error", (error) => {
      console.log("ERROR", error);
      reject(error);
      stream.end();
    });
    stream.on("end", () => {
      resolve();
    });
    stream.on("close", () => {
      resolve();
    });
  });

  // Handle updates
  stream.on("data", (data) => {
    if (data?.transaction) {
      const txn = TXN_FORMATTER.formTransactionFromJson(
        data.transaction,
        Date.now()
      );

      const parsedTxn = decodeRaydiumLaunchpad(txn);
      if (!parsedTxn) return;
      
      // Filter for initialize instructions only
      const initializeInstruction = parsedTxn.instructions?.find((ix: any) => ix.name === "initialize");
      if (!initializeInstruction) return;
      
      // Debug: Log the full instruction to understand structure
      console.log("Initialize instruction accounts:", initializeInstruction.accounts?.map((acc: any) => ({
        name: acc.name,
        pubkey: acc.pubkey
      })));
      
      // Extract token information from the initialize instruction
      const poolState = initializeInstruction.accounts?.find((acc: any) => acc.name === "pool_state")?.pubkey;
      const baseTokenMint = initializeInstruction.accounts?.find((acc: any) => acc.name === "base_mint")?.pubkey;
      const quoteTokenMint = initializeInstruction.accounts?.find((acc: any) => acc.name === "quote_mint")?.pubkey;
      const creator = initializeInstruction.accounts?.find((acc: any) => acc.name === "creator")?.pubkey;
      
      // Skip if we don't have the required token mint
      if (!baseTokenMint) {
        console.log("Warning: baseTokenMint not found in instruction accounts");
        return;
      }
      
      const output = {
        timestamp: new Date().toISOString(),
        signature: txn.transaction.signatures[0],
        poolState: poolState?.toString(),
        baseTokenMint: baseTokenMint?.toString(),
        quoteTokenMint: quoteTokenMint?.toString() === 'So11111111111111111111111111111111111111112' ? 'SOL' : quoteTokenMint?.toString(),
        initialPrice: (initializeInstruction.args as any)?.initial_price,
        initialLiquidity: (initializeInstruction.args as any)?.initial_liquidity,
        creator: creator?.toString() || 'unknown',
        solscanUrl: `https://solscan.io/tx/${txn.transaction.signatures[0]}`,
        shyftUrl: `https://translator.shyft.to/tx/${txn.transaction.signatures[0]}`
      };
      
      console.log(
        new Date(),
        ":",
        `New token mint detected\n`,
        JSON.stringify(output, null, 2) + "\n"
      );
      
      // Save to database
      saveRaydiumToken(output).catch(error => {
        console.error("Failed to save token to database:", error);
      });
      
      console.log(
        "--------------------------------------------------------------------------------------------------"
      );
    }
  });

  // Send subscribe request
  await new Promise<void>((resolve, reject) => {
    stream.write(args, (err: any) => {
      if (err === null || err === undefined) {
        resolve();
      } else {
        reject(err);
      }
    });
  }).catch((reason) => {
    console.error(reason);
    throw reason;
  });

  await streamClosed;
}

async function subscribeCommand(client: Client, args: SubscribeRequest) {
  console.log("Raydium Launchpad New Token Monitor");
  console.log("Monitoring for initialize instructions...\n");
  
  while (true) {
    try {
      await handleStream(client, args);
    } catch (error) {
      console.error("Stream error, restarting in 1 second...", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

const client = new Client(
  process.env.GRPC_URL!,
  process.env.X_TOKEN!,
  undefined
);

const req: SubscribeRequest = {
  accounts: {},
  slots: {},
  transactions: {
    Raydium_Launchpad: {
      vote: false,
      failed: false,
      signature: undefined,
      accountInclude: [RAYDIUM_LAUNCHPAD_PROGRAM_ID.toBase58()],
      accountExclude: [],
      accountRequired: [],
    },
  },
  transactionsStatus: {},
  entry: {},
  blocks: {},
  blocksMeta: {},
  accountsDataSlice: [],
  ping: undefined,
  commitment: CommitmentLevel.CONFIRMED,
};

subscribeCommand(client, req);


function decodeRaydiumLaunchpad(tx: VersionedTransactionResponse) {
  if (tx.meta?.err) return;

  try {
    const parsedIxs = RAYDIUM_LAUNCHPAD_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta!.loadedAddresses
    );

    const raydiumLaunchpadIxs = parsedIxs.filter((ix) =>
      ix.programId.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID)
    );

    if (raydiumLaunchpadIxs.length === 0) return;

    const cleanedInstructions = raydiumLaunchpadIxs.filter((ix: any) => ix.name !== "unknown");

    const result = { instructions: cleanedInstructions };
    bnLayoutFormatter(result);

    return result;
  } catch (err) {
    // Silent error handling
  }
}