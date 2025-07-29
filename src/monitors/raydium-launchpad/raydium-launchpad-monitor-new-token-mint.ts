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
import { SolanaEventParser } from "./utils/event-parser";
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import raydiumLaunchpadIdl from "./idls/raydium_launchpad.json";

// Suppress parser warnings for known programs early
const originalConsoleWarn = console.warn;
console.warn = (...args: any[]) => {
  const firstArg = args[0];
  if (typeof firstArg === 'string' && 
      (firstArg.includes('Parser does not matching') || 
       firstArg.includes('ComputeBudget'))) {
    return; // Suppress parser warnings for ComputeBudget and other unrecognized programs
  }
  originalConsoleWarn.apply(console, args);
};

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
const RAYDIUM_LAUNCHPAD_EVENT_PARSER = new SolanaEventParser([], console);
RAYDIUM_LAUNCHPAD_EVENT_PARSER.addParserFromIdl(
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
      
      totalTransactions++;
      
      // Look for initialize instruction in any position
      const allInstructions = [...(parsedTxn.instructions || []), ...(parsedTxn.inner_ixs || [])];
      const initInstruction = allInstructions.find((ix: any) => ix.name === "initialize");
      
      if (!initInstruction) {
        return; // Silently skip non-initialize transactions
      }
      
      initializeCount++;
      lastStatusTime = Date.now();
      console.log(`\n[INFO] Found initialize instruction in transaction ${txn.transaction.signatures[0]}`);
      

      // Extract all relevant information
      const poolState = initInstruction.accounts?.find((acc: any) => acc.name === "pool_state")?.pubkey;
      const baseTokenMint = initInstruction.accounts?.find((acc: any) => acc.name === "base_token_mint")?.pubkey;
      const quoteTokenMint = initInstruction.accounts?.find((acc: any) => acc.name === "quote_token_mint")?.pubkey;
      const baseVault = initInstruction.accounts?.find((acc: any) => acc.name === "base_vault")?.pubkey;
      const quoteVault = initInstruction.accounts?.find((acc: any) => acc.name === "quote_vault")?.pubkey;
      
      // Look for mint initialization in inner instructions if base token mint is new
      const mintInitIx = parsedTxn.inner_ixs?.find((ix: any) => 
        ix.name === "initializeMint2" || ix.name === "initializeMint"
      );
      
      const tokenMint = mintInitIx?.accounts?.find((acc: any) => acc.name === "mint")?.pubkey || baseTokenMint;
      
      console.log("\n🚀 NEW TOKEN LAUNCH ON RAYDIUM LAUNCHPAD");
      console.log("==========================================");
      console.log(`Time: ${new Date().toISOString()}`);
      console.log(`Transaction: https://solscan.io/tx/${txn.transaction.signatures[0]}`);
      console.log(`Token Mint: ${tokenMint || 'N/A'}`);
      console.log(`Pool State: ${poolState || 'N/A'}`);
      console.log(`Quote Token: ${quoteTokenMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : quoteTokenMint || 'N/A'}`);
      console.log(`Base Vault: ${baseVault || 'N/A'}`);
      console.log(`Quote Vault: ${quoteVault || 'N/A'}`);
      
      // Extract initialization parameters if available
      if (initInstruction.args) {
        console.log(`Initial Price: ${initInstruction.args.initial_price || 'N/A'}`);
        console.log(`Liquidity: ${initInstruction.args.initial_liquidity || 'N/A'}`);
      }
      
      console.log("==========================================\n");
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

// Track statistics
let totalTransactions = 0;
let initializeCount = 0;
let lastStatusTime = Date.now();

async function subscribeCommand(client: Client, args: SubscribeRequest) {
  console.log("Starting Raydium Launchpad New Token Monitor...");
  console.log("Monitoring for new token launches (initialize instructions)");
  console.log("Note: New token launches are rare - expect 1-2 per few minutes");
  console.log("Press Ctrl+C to stop monitoring.\n");
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nFinal Statistics:');
    console.log(`Total transactions monitored: ${totalTransactions}`);
    console.log(`New token launches found: ${initializeCount}`);
    console.log('Shutting down monitor...');
    process.exit(0);
  });

  // Show periodic status updates
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - lastStatusTime) / 1000);
    console.log(`[STATUS] Monitoring... ${totalTransactions} transactions checked, ${initializeCount} new tokens found (${elapsed}s elapsed)`);
  }, 30000); // Every 30 seconds

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

  // Store original console.warn at function scope
  const originalWarn = console.warn;

  try {
    // Temporarily suppress warnings during parsing
    console.warn = () => {};
    
    const paredIxs = RAYDIUM_LAUNCHPAD_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta!.loadedAddresses
    );

    const raydiumLaunchpadIxs = paredIxs.filter((ix) =>
      ix.programId.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID) ||
      ix.programId.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))
    );

    const parsedInnerIxs = RAYDIUM_LAUNCHPAD_IX_PARSER.parseTransactionWithInnerInstructions(tx);
    
    // Restore console.warn after parsing
    console.warn = originalWarn;
    const raydium_launchpad_inner_ixs = parsedInnerIxs.filter((ix) =>
      ix.programId.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID) ||
      ix.programId.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))
    );

    const allInstructions = [...raydiumLaunchpadIxs, ...raydium_launchpad_inner_ixs];

    if (allInstructions.length === 0) return;

    const decodeAndCleanUnknownFields = (instructions: any[]) => {
      return instructions
        .filter((ix: any) => ix.name !== "unknown") 
        .map((ix: any) => {
          if (ix.args?.unknown) {
            delete ix.args.unknown;
          }
          if (ix.innerInstructions) {
            ix.innerInstructions = decodeAndCleanUnknownFields(ix.innerInstructions);
          }
          return ix;
        });
    };

    const cleanedInstructions = decodeAndCleanUnknownFields(raydiumLaunchpadIxs);
    const cleanedInnerInstructions = decodeAndCleanUnknownFields(raydium_launchpad_inner_ixs);

    const events = RAYDIUM_LAUNCHPAD_EVENT_PARSER.parseEvent(tx);

    const result = events.length > 0
      ? { instructions: cleanedInstructions, inner_ixs: cleanedInnerInstructions, events }
      : { instructions: cleanedInstructions, inner_ixs: cleanedInnerInstructions };

    bnLayoutFormatter(result);
    
    // Restore console.warn
    console.warn = originalWarn;

    return result;
  } catch (err) {
    // Restore console.warn on error
    console.warn = originalWarn;
  }
}