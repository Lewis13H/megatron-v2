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

const TXN_FORMATTER = new TransactionFormatter();
const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

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
  // Subscribe for events
  console.log("\n" + "=".repeat(80));
  console.log("💹 PUMPSWAP AMM PRICE MONITOR");
  console.log("=".repeat(80));
  console.log("📍 Tracking: Real-time price updates from PumpSwap AMM");
  console.log("🎯 Program: " + PUMP_AMM_PROGRAM_ID.toBase58());
  console.log("=".repeat(80) + "\n");
  
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

      const parsedTxn = decodePumpAmmTxn(txn);

      if (!parsedTxn) return;
      const formattedSwapTxn = await parseSwapTransactionOutput(parsedTxn, txn);
      if (!formattedSwapTxn) return;
      
      // Always log the swap transaction (like Shyft example)
      console.log(
        new Date(),
        ":",
        `New transaction https://translator.shyft.to/tx/${txn.transaction.signatures[0]} \n`,
        JSON.stringify(formattedSwapTxn, null, 2) + "\n",
      );
      console.log(
        "--------------------------------------------------------------------------------------------------"
      );
      
      // Update database for existing tokens only
      await updateTokenPrice(formattedSwapTxn, txn.transaction.signatures[0]);
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
    const parsedIxs = PUMP_AMM_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta!.loadedAddresses,
    );

    const pumpAmmIxs = parsedIxs.filter((ix) =>
      ix.programId.equals(PUMP_AMM_PROGRAM_ID) || ix.programId.equals(TOKEN_PROGRAM_ID),
    );

    const parsedInnerIxs = PUMP_AMM_IX_PARSER.parseTransactionWithInnerInstructions(tx);

    const pump_amm_inner_ixs = parsedInnerIxs.filter((ix) =>
      ix.programId.equals(PUMP_AMM_PROGRAM_ID) || ix.programId.equals(TOKEN_PROGRAM_ID),
    );

    if (pumpAmmIxs.length === 0) return;
    const events = PUMP_AMM_EVENT_PARSER.parseEvent(tx);
    const result = { instructions: { pumpAmmIxs, events }, inner_ixs: pump_amm_inner_ixs };
    bnLayoutFormatter(result);
    return result;
  } catch (err) {
    // Suppress errors
  }
}

async function parseSwapTransactionOutput(parsedInstruction: any, txn: any) {
  let price;
  const decimal = txn.meta?.preTokenBalances.find(
    (instruction: any) => instruction.mint != SOL_MINT
  )?.uiTokenAmount?.decimals;
  
  const swapInstruction = parsedInstruction.instructions.pumpAmmIxs.find(
    (instruction: any) => instruction.name === 'buy' || instruction.name === 'sell'
  );

  if (!swapInstruction) {
    return;
  }
  
  const baseMintPubkey = swapInstruction.accounts.find((account: any) => account.name === 'base_mint')?.pubkey;
  const quoteMintPubkey = swapInstruction.accounts.find((account: any) => account.name === 'quote_mint')?.pubkey;
  const poolPubkey = swapInstruction.accounts.find((account: any) => account.name === 'pool')?.pubkey;

  const parsedEvent = parsedInstruction.instructions.events[0]?.data;
  if (!parsedEvent) return;
  
  const pool_base_token_reserves = parsedEvent.pool_base_token_reserves;
  const pool_quote_token_reserves = parsedEvent.pool_quote_token_reserves;
  
  if (baseMintPubkey === SOL_MINT) {
    price = calculatePumpAmmPrice(
      pool_base_token_reserves,
      pool_quote_token_reserves,
      decimal || 6
    );
  } else {
    price = calculatePumpAmmPrice(
      pool_quote_token_reserves,
      pool_base_token_reserves,
      decimal || 6
    );
  }
  
  const formattedPrice = price.toFixed(20).replace(/0+$/, '');
  const output = {
    base_mint: baseMintPubkey,
    quote_mint: quoteMintPubkey,
    pool_base_token_reserver: pool_base_token_reserves,
    pool_quote_token_reserver: pool_quote_token_reserves,
    price: formattedPrice + " SOL",
    // Additional fields for database update
    pool_address: poolPubkey,
    price_sol: parseFloat(formattedPrice),
    token_mint: baseMintPubkey === SOL_MINT ? quoteMintPubkey : baseMintPubkey,
    is_buy: swapInstruction.name === 'buy'
  };
  
  return output;
}

function calculatePumpAmmPrice(
  pool_base_reserve: number,
  pool_quote_reserve: number,
  decimal: number
): number {
  const base = pool_base_reserve / 1_000_000_000;
  const quote = pool_quote_reserve / Math.pow(10, decimal);
  return base / quote;
}

async function updateTokenPrice(swapData: any, signature: string) {
  try {
    // Check if token exists in database
    const token = await monitorService.getTokenByMint(swapData.token_mint);
    if (!token) {
      // Token not in database, skip update
      return;
    }

    // Get pool from database
    const pool = await monitorService.getPoolByAddress(swapData.pool_address);
    if (!pool) {
      // Pool not in database, skip update
      return;
    }

    // Get SOL price
    const solPrice = (await monitorService.getLatestSolPrice()) || 200;
    const priceUsd = swapData.price_sol * solPrice;

    // Update pool with latest price and reserves
    await monitorService.execute(
      `UPDATE pools 
       SET real_sol_reserves = $2,
           real_token_reserves = $3,
           latest_price = $4,
           latest_price_usd = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [
        pool.id,
        swapData.pool_base_token_reserves?.toString() || "0",
        swapData.pool_quote_token_reserves?.toString() || "0",
        swapData.price_sol,
        priceUsd
      ]
    );

    // Record price in time series
    await monitorService.savePrice({
      pool_id: pool.id,
      price_sol: swapData.price_sol,
      price_usd: priceUsd,
      volume_sol: 0, // Volume tracked separately
      volume_usd: 0,
      timestamp: new Date()
    });

    // Only log database updates if token exists
    // console.log(`💾 Updated price for ${swapData.token_mint.slice(0, 8)}...`);

  } catch (error) {
    console.error("Error updating token price:", error);
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
export default class PumpSwapPriceMonitor {
  async start() {
    await subscribeCommand(client, req);
  }

  async stop() {
    console.log("Stopping PumpSwap Price Monitor...");
    // Client will handle cleanup on process exit
  }
}

// If run directly
if (require.main === module) {
  const monitor = new PumpSwapPriceMonitor();
  
  process.on("SIGINT", async () => {
    await monitor.stop();
    process.exit(0);
  });

  monitor.start().catch(console.error);
}