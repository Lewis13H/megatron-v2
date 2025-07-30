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
import { SolanaEventParser } from "./utils/event-parser";
import pumpFunIdl from "./idls/pump_0.1.0.json";
import { savePumpfunToken } from "../../database/monitor-integration";
import { getDbPool, PoolOperations } from "../../database";

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

interface CreateTokenData {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  mintAuthority: string;
  bondingCurve: string;
  associatedBondingCurve: string;
  global: string;
  mplTokenMetadata: string;
  metadata: string;
  user: string;
  timestamp: string;
  signature: string;
  slot?: number;
}

const TXN_FORMATTER = new TransactionFormatter();
const PUMP_FUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const PUMP_FUN_IX_PARSER = new SolanaParser([]);
PUMP_FUN_IX_PARSER.addParserFromIdl(
  PUMP_FUN_PROGRAM_ID.toBase58(),
  pumpFunIdl as Idl
);
const PUMP_FUN_EVENT_PARSER = new SolanaEventParser([], console);
PUMP_FUN_EVENT_PARSER.addParserFromIdl(
  PUMP_FUN_PROGRAM_ID.toBase58(),
  pumpFunIdl as Idl
);

// Initialize database operations
const dbPool = getDbPool();
const poolOperations = new PoolOperations(dbPool);

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("Starting Pump.fun New Token Mint Monitor V2...")
  console.log("Monitoring for new token creation events...\n");
  
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
  stream.on("data", async (data) => {
    if (data?.transaction) {
      const txn = TXN_FORMATTER.formTransactionFromJson(
        data.transaction,
        Date.now()
      );

      const parsedTxn = decodePumpFunTransaction(txn);
      if (!parsedTxn) return;
      
      // Look for create instruction
      const createInstruction = parsedTxn.instructions.find(
        (ix: any) => ix.name === "create"
      );
      
      if (!createInstruction) return;
      
      // Type guard to ensure we have the right instruction type
      if (!('args' in createInstruction) || !('accounts' in createInstruction)) return;
      
      // Extract all the data from the create instruction
      const createData = createInstruction.args as any;
      const accounts = createInstruction.accounts as any[];
      
      // Map account names to their public keys
      const accountMap: { [key: string]: string } = {};
      accounts.forEach((account: any) => {
        accountMap[account.name] = account.pubkey || account.address || account.publicKey || "";
      });
      
      // Debug log to see account structure
      if (!accountMap.mint || accountMap.mint === "") {
        console.log("Debug - Account structure:", JSON.stringify(accounts.slice(0, 3), null, 2));
      }
      
      const tokenData: CreateTokenData = {
        name: createData.name || "",
        symbol: createData.symbol || "",
        uri: createData.uri || "",
        mint: accountMap.mint || "",
        mintAuthority: accountMap.mintAuthority || "",
        bondingCurve: accountMap.bondingCurve || "",
        associatedBondingCurve: accountMap.associatedBondingCurve || "",
        global: accountMap.global || "",
        mplTokenMetadata: accountMap.mplTokenMetadata || "",
        metadata: accountMap.metadata || "",
        user: accountMap.user || "",
        timestamp: new Date().toISOString(),
        signature: txn.transaction.signatures[0],
        slot: data.slot,
      };
      
      console.log(
        `[NEW TOKEN CREATED]`,
        new Date(),
        "\n",
        JSON.stringify({
          ...tokenData,
          pumpFunUrl: `https://pump.fun/coin/${tokenData.mint}`,
          solscanUrl: `https://solscan.io/tx/${tokenData.signature}`,
          shyftUrl: `https://translator.shyft.to/tx/${tokenData.signature}`
        }, null, 2) + "\n"
      );
      
      // Save to database
      try {
        const saveData = {
          Ca: tokenData.mint,
          mint: tokenData.mint,
          signature: tokenData.signature,
          timestamp: tokenData.timestamp,
          creator: tokenData.user,
          name: tokenData.name,
          symbol: tokenData.symbol,
          metadata: {
            uri: tokenData.uri,
            bondingCurve: tokenData.bondingCurve,
            mintAuthority: tokenData.mintAuthority,
            associatedBondingCurve: tokenData.associatedBondingCurve,
            global: tokenData.global,
            mplTokenMetadata: tokenData.mplTokenMetadata,
            metadataAccount: tokenData.metadata,
            slot: tokenData.slot
          }
        };
        
        await savePumpfunToken(saveData);
        console.log(`💾 New token saved to database`);
      } catch (error) {
        console.error(`❌ Failed to save token:`, error);
      }
      
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
  console.log("Pump.fun New Token Mint Monitor V2");
  console.log("==================================");
  console.log("Program ID:", PUMP_FUN_PROGRAM_ID.toBase58());
  console.log("");
  
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
    pumpFun: {
      vote: false,
      failed: false,
      signature: undefined,
      accountInclude: [PUMP_FUN_PROGRAM_ID.toBase58()],
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

function decodePumpFunTransaction(tx: VersionedTransactionResponse) {
  if (tx.meta?.err) return;
  
  try {
    const parsedIxs = PUMP_FUN_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta!.loadedAddresses
    );
    
    const pumpFunIxs = parsedIxs.filter((ix) =>
      ix.programId.equals(PUMP_FUN_PROGRAM_ID)
    );
    
    const hydratedTx = hydrateLoadedAddresses(tx);
    const parsedInnerIxs = PUMP_FUN_IX_PARSER.parseTransactionWithInnerInstructions(hydratedTx);
    const pumpfunInnerIxs = parsedInnerIxs.filter((ix) =>
      ix.programId.equals(PUMP_FUN_PROGRAM_ID)
    );
    
    if (pumpFunIxs.length === 0 && pumpfunInnerIxs.length === 0) return;
    
    const events = PUMP_FUN_EVENT_PARSER.parseEvent(tx);
    const result = { instructions: pumpFunIxs, inner_ixs: pumpfunInnerIxs, events };
    bnLayoutFormatter(result);
    
    return result;
  } catch (err) {
    // Silent error handling for unrecognized instructions
  }
}

function hydrateLoadedAddresses(tx: VersionedTransactionResponse): VersionedTransactionResponse {
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return tx;

  function ensurePublicKey(arr: (Buffer | PublicKey)[]) {
    return arr.map(item =>
      item instanceof PublicKey ? item : new PublicKey(item)
    );
  }

  tx.meta!.loadedAddresses = {
    writable: ensurePublicKey(loaded.writable),
    readonly: ensurePublicKey(loaded.readonly),
  };

  return tx;
}