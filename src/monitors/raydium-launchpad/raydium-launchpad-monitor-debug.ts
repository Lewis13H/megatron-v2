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
import raydiumLaunchpadIdl from "./idls/raydium_launchpad.json";

// Suppress parser warnings
console.warn = () => {};

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

// Track unique instruction combinations
const instructionPatterns = new Map<string, number>();
let totalTransactions = 0;
let initializeCount = 0;

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("Starting Stream...")
  const stream = await client.subscribe();

  // Create error / end handler
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
      
      totalTransactions++;
      
      // Get all instruction names
      const instructionNames = [
        ...(parsedTxn.instructions || []).map((ix: any) => ix.name),
        ...(parsedTxn.inner_ixs || []).map((ix: any) => `inner:${ix.name}`)
      ].filter(Boolean).sort().join(',');
      
      // Track pattern
      instructionPatterns.set(instructionNames, (instructionPatterns.get(instructionNames) || 0) + 1);
      
      // Check for initialize
      const hasInitialize = parsedTxn.instructions?.some((ix: any) => ix.name === "initialize") ||
                           parsedTxn.inner_ixs?.some((ix: any) => ix.name === "initialize");
      
      if (hasInitialize) {
        initializeCount++;
        console.log(`\n🚀 FOUND INITIALIZE! Transaction: https://solscan.io/tx/${txn.transaction.signatures[0]}`);
        console.log(`Instructions: ${instructionNames}`);
      }
      
      // Every 100 transactions, show statistics
      if (totalTransactions % 100 === 0) {
        console.log(`\n--- Statistics after ${totalTransactions} transactions ---`);
        console.log(`Initialize count: ${initializeCount}`);
        console.log(`\nTop instruction patterns:`);
        const sortedPatterns = Array.from(instructionPatterns.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        
        sortedPatterns.forEach(([pattern, count]) => {
          console.log(`  ${count}x: ${pattern || '(empty)'}`);
        });
        console.log('---\n');
      }
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
  console.log("Starting Raydium Launchpad Debug Monitor...");
  console.log("This will analyze instruction patterns to find new token launches.");
  console.log("Press Ctrl+C to stop monitoring.\n");
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nFinal Statistics:');
    console.log(`Total transactions: ${totalTransactions}`);
    console.log(`Initialize count: ${initializeCount}`);
    console.log(`Rate: ${initializeCount > 0 ? (totalTransactions / initializeCount).toFixed(1) : 'N/A'} transactions per initialize`);
    process.exit(0);
  });

  while (true) {
    try {
      await handleStream(client, args);
    } catch (error) {
      console.error("Stream error, restarting in 1 second...", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Check environment variables
if (!process.env.GRPC_URL || !process.env.X_TOKEN) {
  console.error("Missing required environment variables: GRPC_URL or X_TOKEN");
  console.error("Please ensure .env file is properly configured");
  process.exit(1);
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
    const paredIxs = RAYDIUM_LAUNCHPAD_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta!.loadedAddresses
    );

    const raydiumLaunchpadIxs = paredIxs.filter((ix) =>
      ix.programId.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID) ||
      ix.programId.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))
    );

    const parsedInnerIxs = RAYDIUM_LAUNCHPAD_IX_PARSER.parseTransactionWithInnerInstructions(tx);
    const raydium_launchpad_inner_ixs = parsedInnerIxs.filter((ix) =>
      ix.programId.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID) ||
      ix.programId.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))
    );

    const result = {
      instructions: raydiumLaunchpadIxs,
      inner_ixs: raydium_launchpad_inner_ixs
    };

    return result;
  } catch (err) {
    // Silent error handling
  }
}