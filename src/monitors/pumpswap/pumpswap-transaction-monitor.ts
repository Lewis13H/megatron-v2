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
import { monitorService } from "../../database";
import * as fs from "fs";
import * as path from "path";
import { isObject } from "lodash";

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

interface TransactionEvent {
  type: "Buy" | "Sell";
  user: string;
  mint: string;
  in_amount: number;
  out_amount: number;
  pool: string;
  signature: string;
  timestamp: Date;
}

const TXN_FORMATTER = new TransactionFormatter();
const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Load IDL
const idlPath = path.join(__dirname, "idls", "pump_amm_0.1.0.json");
const pumpAmmIdl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

const PUMP_AMM_IX_PARSER = new SolanaParser([]);
PUMP_AMM_IX_PARSER.addParserFromIdl(
  PUMP_AMM_PROGRAM_ID.toBase58(),
  pumpAmmIdl as Idl
);

const PUMP_AMM_EVENT_PARSER = new SolanaEventParser([], console);
PUMP_AMM_EVENT_PARSER.addParserFromIdl(
  PUMP_AMM_PROGRAM_ID.toBase58(),
  pumpAmmIdl as Idl
);

// Suppress parser warnings
const originalConsoleWarn = console.warn;
console.warn = (message?: any, ...optionalParams: any[]) => {
  if (
    typeof message === "string" &&
    message.includes("Parser does not matching the instruction args")
  ) {
    return;
  }
  originalConsoleWarn(message, ...optionalParams);
};

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("\n" + "=".repeat(80));
  console.log("📝 PUMPSWAP TRANSACTION MONITOR");
  console.log("=".repeat(80));
  console.log("📍 Tracking: Buy and Sell transactions on PumpSwap AMM");
  console.log("🎯 Program: " + PUMP_AMM_PROGRAM_ID.toBase58());
  console.log("💾 Saving: Transaction history with user details");
  console.log("=".repeat(80) + "\n");
  
  const stream = await client.subscribe();

  // Create error/end handler
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

      const parsedTxn = decodePumpAmmTxn(txn);
      if (!parsedTxn) return;

      const transactionEvent = parseSwapTransaction(parsedTxn, txn);
      if (!transactionEvent) return;

      // Log the transaction
      console.log(
        new Date().toISOString(),
        ":",
        `New ${transactionEvent.type} transaction https://translator.shyft.to/tx/${txn.transaction.signatures[0]}`
      );
      console.log(`  👤 User: ${transactionEvent.user}`);
      console.log(`  🪙 Token: ${transactionEvent.mint}`);
      console.log(`  💸 In Amount: ${transactionEvent.in_amount}`);
      console.log(`  💰 Out Amount: ${transactionEvent.out_amount}`);
      console.log("─".repeat(100));

      // Save to database
      await saveTransaction(transactionEvent);
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
  while (true) {
    try {
      await handleStream(client, args);
    } catch (error) {
      console.error("Stream error, restarting in 1 second...", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function decodePumpAmmTxn(tx: VersionedTransactionResponse) {
  if (tx.meta?.err) return;
  
  try {
    // Parse main instructions
    const parsedIxs = PUMP_AMM_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta!.loadedAddresses,
    );

    // Filter for PumpAMM and Token Program instructions
    const pumpAmmIxs = parsedIxs.filter((ix) =>
      ix.programId.equals(PUMP_AMM_PROGRAM_ID) || ix.programId.equals(TOKEN_PROGRAM_ID),
    );

    // Parse inner instructions - CRITICAL for accurate amount tracking
    const parsedInnerIxs = PUMP_AMM_IX_PARSER.parseTransactionWithInnerInstructions(tx);
    
    const pump_amm_inner_ixs = parsedInnerIxs.filter((ix) =>
      ix.programId.equals(PUMP_AMM_PROGRAM_ID) || ix.programId.equals(TOKEN_PROGRAM_ID),
    );

    if (pumpAmmIxs.length === 0) return;
    
    // Parse events
    const events = PUMP_AMM_EVENT_PARSER.parseEvent(tx);
    
    const result = { 
      instructions: { pumpAmmIxs, events }, 
      inner_ixs: pump_amm_inner_ixs 
    };
    
    bnLayoutFormatter(result);
    return result;
  } catch (err) {
    // Suppress errors
  }
}

function parseSwapTransaction(parsedInstruction: any, txn: any): TransactionEvent | null {
  try {
    // Find the swap instruction (buy or sell)
    const swapInstruction = parsedInstruction.instructions.pumpAmmIxs.find(
      (instruction: any) => instruction.name === 'buy' || instruction.name === 'sell'
    );

    if (!swapInstruction) {
      return null;
    }

    // Extract key accounts
    const userPubkey = swapInstruction.accounts.find((account: any) => account.name === 'user')?.pubkey;
    const poolPubkey = swapInstruction.accounts.find((account: any) => account.name === 'pool')?.pubkey;
    const baseMintPubkey = swapInstruction.accounts.find((account: any) => account.name === 'base_mint')?.pubkey;
    const quoteMintPubkey = swapInstruction.accounts.find((account: any) => account.name === 'quote_mint')?.pubkey;

    // Determine token mint (non-SOL mint)
    const tokenMint = baseMintPubkey === SOL_MINT ? quoteMintPubkey : baseMintPubkey;

    // Extract swap amounts from instruction args
    const swapAmount = swapInstruction.name === 'sell'
      ? swapInstruction.args?.base_amount_in
      : swapInstruction.args?.base_amount_out;

    // Find the actual output amount from inner transfer instructions
    const determineOutAmount = () => {
      if (!parsedInstruction.inner_ixs || parsedInstruction.inner_ixs.length === 0) {
        // Fallback to instruction args if no inner instructions
        return swapInstruction.name === 'sell'
          ? swapInstruction.args?.min_quote_amount_out
          : swapInstruction.args?.max_quote_amount_in;
      }
      
      // Find transferChecked instruction with different amount than swap
      const transferChecked = parsedInstruction.inner_ixs.find(
        (instruction: any) =>
          instruction.name === 'transferChecked' && 
          instruction.args?.amount !== swapAmount
      );
      
      return transferChecked?.args?.amount || 0;
    };

    const amountIn = swapInstruction.name === 'buy'
      ? determineOutAmount()  // For buy, user puts in quote token
      : swapAmount;           // For sell, user puts in base token

    const amountOut = swapInstruction.name === 'sell'
      ? determineOutAmount()  // For sell, user gets quote token
      : swapAmount;           // For buy, user gets base token

    return {
      type: swapInstruction.name === 'buy' ? "Buy" : "Sell",
      user: userPubkey || "",
      mint: tokenMint || "",
      in_amount: Number(amountIn || 0),
      out_amount: Number(amountOut || 0),
      pool: poolPubkey || "",
      signature: txn.transaction.signatures[0],
      timestamp: new Date()
    };
  } catch (error) {
    console.error("Error parsing swap transaction:", error);
    return null;
  }
}

async function saveTransaction(event: TransactionEvent) {
  try {
    // Check if token exists in database
    const token = await monitorService.getTokenByMint(event.mint);
    if (!token) {
      // Token not in database, skip saving
      return;
    }

    // Get pool from database
    const pool = await monitorService.getPoolByAddress(event.pool);
    if (!pool) {
      // Pool not in database, skip saving
      return;
    }

    // Calculate amounts in proper units
    const solAmount = event.type === "Buy" 
      ? event.in_amount / 1e9   // User puts in SOL
      : event.out_amount / 1e9; // User gets SOL

    const tokenAmount = event.type === "Buy"
      ? event.out_amount / 1e6  // User gets tokens
      : event.in_amount / 1e6;  // User puts in tokens

    // Get SOL price for USD calculation
    const solPrice = (await monitorService.getLatestSolPrice()) || 200;

    // Save transaction to database
    await monitorService.saveTransaction({
      pool_id: pool.id,
      signature: event.signature,
      type: event.type.toLowerCase() as "buy" | "sell",
      user_address: event.user,
      token_amount: tokenAmount.toString(),
      sol_amount: solAmount.toString(),
      price_per_token: tokenAmount > 0 ? solAmount / tokenAmount : 0,
      block_time: event.timestamp,
      slot: 0  // We don't have slot from the parsed data
    });

    console.log(`💾 Saved ${event.type} transaction for ${event.mint.slice(0, 8)}...`);

  } catch (error) {
    console.error("Error saving transaction:", error);
  }
}

// BN Layout formatter helper
function bnLayoutFormatter(obj: any) {
  for (const key in obj) {
    if (obj[key]?.constructor?.name === "PublicKey") {
      obj[key] = (obj[key] as PublicKey).toBase58();
    } else if (obj[key]?.constructor?.name === "BN") {
      obj[key] = Number(obj[key].toString());
    } else if (obj[key]?.constructor?.name === "BigInt") {
      obj[key] = Number(obj[key].toString());
    } else if (obj[key]?.constructor?.name === "Buffer") {
      obj[key] = (obj[key] as Buffer).toString("base64");
    } else if (isObject(obj[key])) {
      bnLayoutFormatter(obj[key]);
    } else {
      obj[key] = obj[key];
    }
  }
}

// Main execution
const client = new Client(
  process.env.GRPC_URL!,
  process.env.X_TOKEN,
  undefined
);

const req: SubscribeRequest = {
  accounts: {},
  slots: {},
  transactions: {
    pumpAmm: {
      vote: false,
      failed: false,
      signature: undefined,
      accountInclude: [PUMP_AMM_PROGRAM_ID.toBase58()],
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

// Export for use in npm scripts
export default class PumpSwapTransactionMonitor {
  async start() {
    await subscribeCommand(client, req);
  }

  async stop() {
    console.log("Stopping PumpSwap Transaction Monitor...");
    // Client will handle cleanup on process exit
  }
}

// If run directly
if (require.main === module) {
  const monitor = new PumpSwapTransactionMonitor();
  
  process.on("SIGINT", async () => {
    await monitor.stop();
    process.exit(0);
  });

  monitor.start().catch(console.error);
}