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
const pumpAmmIdl = require("./idls/pump_amm_0.1.0.json");
import { monitorService } from "../../database";

// Suppress parser warnings
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.warn = (message?: any, ...optionalParams: any[]) => {
  if (
    typeof message === "string" &&
    message.includes("Parser does not matching the instruction args")
  ) {
    return; // Suppress this specific warning
  }
  originalConsoleWarn(message, ...optionalParams); 
};

console.log = (message?: any, ...optionalParams: any[]) => {
  if (
    typeof message === "string" &&
    message.includes("Parser does not matching the instruction args")
  ) {
    return; 
  }
  originalConsoleLog(message, ...optionalParams); 
};

console.error = (message?: any, ...optionalParams: any[]) => {
  if (
    typeof message === "string" &&
    message.includes("Parser does not matching the instruction args")
  ) {
    return; // Suppress this specific error
  }
  originalConsoleError(message, ...optionalParams); // Allow other errors
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
const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
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

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("🔄 Starting PumpSwap AMM Monitor - Tracking swap transactions for graduated tokens");
  const stream = await client.subscribe();

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
      
      // Process the transaction and extract swap data
      await processPumpSwapTransaction(parsedTxn, txn);
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

subscribeCommand(client, req);

function decodePumpAmmTxn(tx: VersionedTransactionResponse) {
  if (tx.meta?.err) return;

  try {
    const paredIxs = PUMP_AMM_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta?.loadedAddresses || undefined
    );

    const pumpAmmIxs = paredIxs.filter((ix) =>
      ix.programId.equals(PUMP_AMM_PROGRAM_ID)
    );

    if (pumpAmmIxs.length === 0) return;
    const events = PUMP_AMM_EVENT_PARSER.parseEvent(tx);
    const result = { instructions: pumpAmmIxs, events };
    bnLayoutFormatter(result);
    return result;
  } catch (error) {
    // Silently handle parsing errors
    return null;
  }
}

async function processPumpSwapTransaction(parsedTxn: any, txn: VersionedTransactionResponse) {
  try {
    // Look for buy/sell events in the parsed transaction
    const buyEvents = parsedTxn.events?.filter((event: any) => event.name === 'BuyEvent') || [];
    const sellEvents = parsedTxn.events?.filter((event: any) => event.name === 'SellEvent') || [];
    
    // Process buy events
    for (const buyEvent of buyEvents) {
      await processBuyEvent(buyEvent, txn);
    }
    
    // Process sell events
    for (const sellEvent of sellEvents) {
      await processSellEvent(sellEvent, txn);
    }
    
    // Log transaction summary
    if (buyEvents.length > 0 || sellEvents.length > 0) {
      console.log(
        new Date(),
        ":",
        `PumpSwap transaction https://translator.shyft.to/tx/${txn.transaction.signatures[0]}`,
        `\n💹 Events: ${buyEvents.length} buys, ${sellEvents.length} sells`
      );
      console.log(
        "--------------------------------------------------------------------------------------------------"
      );
    }
  } catch (error) {
    console.error("Error processing PumpSwap transaction:", error);
  }
}

async function processBuyEvent(buyEvent: any, txn: VersionedTransactionResponse) {
  try {
    const pool = buyEvent.data?.pool?.toString();
    const user = buyEvent.data?.user?.toString();
    const baseAmountOut = buyEvent.data?.base_amount_out;
    const quoteAmountIn = buyEvent.data?.quote_amount_in;
    const poolBaseReserves = buyEvent.data?.pool_base_token_reserves;
    const poolQuoteReserves = buyEvent.data?.pool_quote_token_reserves;
    
    if (!pool || !user || !baseAmountOut || !quoteAmountIn) {
      console.warn("Missing required buy event data");
      return;
    }

    // Calculate price per token (quote per base)
    const pricePerToken = parseFloat(quoteAmountIn) / parseFloat(baseAmountOut);
    
    // Get SOL price for USD calculations
    const solPrice = await monitorService.getLatestSolPrice();
    let priceUsd = null;
    if (solPrice) {
      priceUsd = (pricePerToken / 1e9) * solPrice; // Convert lamports to SOL then to USD
    }

    console.log(
      `🟢 PumpSwap BUY`,
      `\n💰 Price: ${(pricePerToken / 1e9).toFixed(9)} SOL` + (priceUsd ? ` ($${priceUsd.toFixed(9)} USD)` : ''),
      `\n📊 Base Out: ${(parseFloat(baseAmountOut) / 1e6).toFixed(2)}`,
      `\n💎 Quote In: ${(parseFloat(quoteAmountIn) / 1e9).toFixed(4)} SOL`,
      `\n🏊‍♂️ Pool: ${pool.slice(0, 8)}...`,
      `\n👤 User: ${user.slice(0, 8)}...`
    );

    // Update pool data in database
    await updatePoolFromSwap(pool, poolBaseReserves, poolQuoteReserves, pricePerToken, priceUsd);
    
    // Save transaction data
    await saveSwapTransaction({
      signature: txn.transaction.signatures[0],
      pool_address: pool,
      block_time: new Date(txn.blockTime! * 1000),
      slot: Number(txn.slot),
      type: 'buy',
      user_address: user,
      sol_amount: parseFloat(quoteAmountIn),
      token_amount: parseFloat(baseAmountOut),
      price_per_token: pricePerToken,
      post_tx_sol_reserves: parseFloat(poolQuoteReserves),
      post_tx_token_reserves: parseFloat(poolBaseReserves),
      metadata: { event_type: 'PumpSwap_Buy', raw_event: buyEvent.data }
    });

  } catch (error) {
    console.error("Error processing buy event:", error);
  }
}

async function processSellEvent(sellEvent: any, txn: VersionedTransactionResponse) {
  try {
    const pool = sellEvent.data?.pool?.toString();
    const user = sellEvent.data?.user?.toString();
    const baseAmountIn = sellEvent.data?.base_amount_in;
    const quoteAmountOut = sellEvent.data?.quote_amount_out;
    const poolBaseReserves = sellEvent.data?.pool_base_token_reserves;
    const poolQuoteReserves = sellEvent.data?.pool_quote_token_reserves;
    
    if (!pool || !user || !baseAmountIn || !quoteAmountOut) {
      console.warn("Missing required sell event data");
      return;
    }

    // Calculate price per token (quote per base)
    const pricePerToken = parseFloat(quoteAmountOut) / parseFloat(baseAmountIn);
    
    // Get SOL price for USD calculations
    const solPrice = await monitorService.getLatestSolPrice();
    let priceUsd = null;
    if (solPrice) {
      priceUsd = (pricePerToken / 1e9) * solPrice; // Convert lamports to SOL then to USD
    }

    console.log(
      `🔴 PumpSwap SELL`,
      `\n💰 Price: ${(pricePerToken / 1e9).toFixed(9)} SOL` + (priceUsd ? ` ($${priceUsd.toFixed(9)} USD)` : ''),
      `\n📊 Base In: ${(parseFloat(baseAmountIn) / 1e6).toFixed(2)}`,
      `\n💎 Quote Out: ${(parseFloat(quoteAmountOut) / 1e9).toFixed(4)} SOL`,
      `\n🏊‍♂️ Pool: ${pool.slice(0, 8)}...`,
      `\n👤 User: ${user.slice(0, 8)}...`
    );

    // Update pool data in database
    await updatePoolFromSwap(pool, poolBaseReserves, poolQuoteReserves, pricePerToken, priceUsd);
    
    // Save transaction data
    await saveSwapTransaction({
      signature: txn.transaction.signatures[0],
      pool_address: pool,
      block_time: new Date(txn.blockTime! * 1000),
      slot: Number(txn.slot),
      type: 'sell',
      user_address: user,
      sol_amount: parseFloat(quoteAmountOut),
      token_amount: parseFloat(baseAmountIn),
      price_per_token: pricePerToken,
      post_tx_sol_reserves: parseFloat(poolQuoteReserves),
      post_tx_token_reserves: parseFloat(poolBaseReserves),
      metadata: { event_type: 'PumpSwap_Sell', raw_event: sellEvent.data }
    });

  } catch (error) {
    console.error("Error processing sell event:", error);
  }
}

async function updatePoolFromSwap(
  poolAddress: string, 
  baseReserves: string, 
  quoteReserves: string, 
  pricePerToken: number,
  priceUsd: number | null
) {
  try {
    // Try to find existing pool
    const existingPool = await monitorService.getPoolByAddress(poolAddress);
    
    if (existingPool) {
      // Update existing pool with new reserves and price
      const updateQuery = `
        UPDATE pools 
        SET 
          virtual_sol_reserves = $1,
          virtual_token_reserves = $2,
          latest_price = $3,
          latest_price_usd = $4,
          updated_at = NOW()
        WHERE pool_address = $5
      `;
      
      await monitorService.execute(updateQuery, [
        quoteReserves,
        baseReserves,
        (pricePerToken / 1e9).toString(), // Convert to SOL
        priceUsd ? priceUsd.toFixed(20).replace(/0+$/, '') : null,
        poolAddress
      ]);
      
      console.log(`💾 Updated PumpSwap pool reserves: ${poolAddress.slice(0, 8)}...`);
    } else {
      console.log(`⚠️  Pool not found in database: ${poolAddress.slice(0, 8)}... (this is expected for new graduated tokens)`);
    }
  } catch (error) {
    console.error("Error updating pool from swap:", error);
  }
}

async function saveSwapTransaction(txData: {
  signature: string;
  pool_address: string;
  block_time: Date;
  slot: number;
  type: 'buy' | 'sell';
  user_address: string;
  sol_amount: number;
  token_amount: number;
  price_per_token: number;
  post_tx_sol_reserves: number;
  post_tx_token_reserves: number;
  metadata: any;
}) {
  try {
    // Try to resolve token/pool IDs for the pool address
    const pool = await monitorService.getPoolByAddress(txData.pool_address);
    
    if (pool && pool.token_id) {
      // Save transaction with resolved IDs
      await monitorService.saveTransaction({
        signature: txData.signature,
        pool_id: pool.id,
        token_id: pool.token_id,
        pool_address: txData.pool_address,
        block_time: txData.block_time,
        slot: txData.slot,
        type: txData.type,
        user_address: txData.user_address,
        sol_amount: txData.sol_amount.toString(),
        token_amount: txData.token_amount.toString(),
        price_per_token: txData.price_per_token,
        post_tx_sol_reserves: txData.post_tx_sol_reserves.toString(),
        post_tx_token_reserves: txData.post_tx_token_reserves.toString(),
        metadata: txData.metadata
      });
      
      console.log(`💾 Saved PumpSwap transaction: ${txData.signature.slice(0, 8)}...`);
    } else {
      console.log(`⚠️  Cannot save transaction - pool not found: ${txData.pool_address.slice(0, 8)}...`);
    }
  } catch (error) {
    console.error("Error saving swap transaction:", error);
  }
}