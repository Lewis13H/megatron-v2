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
import { SubscribeRequestPing } from "@triton-one/yellowstone-grpc/dist/types/grpc/geyser";
import { decodeRaydiumLaunchpadTxnData } from "./utils/raydium-launchpad-transaction-processor";
import { getDbPool } from "../../database";

const RAYDIUM_LAUNCHPAD_PROGRAM_ID = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';

// Global shutdown flag
let isShuttingDown = false;

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

// Price calculation function following original Megatron pattern
function calculatePrice(state: any): number {
  // Original Megatron calculation using virtual reserves
  const virtualBase = parseFloat(state.virtual_base || state.virtualBaseReserve || '0') / 1e9;
  const virtualQuote = parseFloat(state.virtual_quote || state.virtualQuoteReserve || '0') / 1e9;
  
  if (virtualBase === 0) return 0;
  return virtualQuote / virtualBase;
}

async function processPoolUpdate(accountData: any) {
  const poolState = accountData.parsedAccount;
  if (!poolState || !poolState.base_mint) return;

  let dbPool;
  try {
    dbPool = getDbPool();
  } catch (error) {
    console.error("❌ Failed to get database pool:", error);
    return;
  }

  try {
    // Check if pool exists
    const poolResult = await dbPool.query(
      'SELECT id FROM pools WHERE pool_address = $1',
      [accountData.pubKey]
    );

    if (poolResult.rows.length === 0) {
      console.log(`⚠️  Pool ${accountData.pubKey} not found in database.`);
      
      // Check if token exists
      const tokenResult = await dbPool.query(
        'SELECT id FROM tokens WHERE mint_address = $1',
        [poolState.base_mint]
      );
      
      if (tokenResult.rows.length === 0) {
        console.log(`   Token ${poolState.base_mint} not found. Create token first with mint monitor.`);
        return;
      }
      
      // Create the pool entry
      const tokenId = tokenResult.rows[0].id;
      console.log(`   Creating new pool entry for token ${poolState.base_mint}`);
      
      await dbPool.query(
        `INSERT INTO pools (
          pool_address, token_id, base_mint, quote_mint, platform,
          virtual_sol_reserves, virtual_token_reserves, 
          real_sol_reserves, real_token_reserves,
          base_vault, quote_vault,
          status, bonding_curve_progress
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (pool_address) DO NOTHING`,
        [
          accountData.pubKey,
          tokenId,
          poolState.base_mint,
          poolState.quote_mint || 'So11111111111111111111111111111111111111112',
          'raydium_launchpad',
          poolState.virtual_quote || '0',
          poolState.virtual_base || '0',
          poolState.real_quote || '0',
          poolState.real_base || '0',
          poolState.base_vault || null,
          poolState.quote_vault || null,
          poolState.status === 0 ? 'active' : 'graduated',
          '0'
        ]
      );
      
      console.log(`💾 New pool created in database: ${accountData.pubKey}`);
    }

    // Now update the pool with latest data
    const updatePoolResult = await dbPool.query(
      'SELECT id FROM pools WHERE pool_address = $1',
      [accountData.pubKey]
    );
    
    if (updatePoolResult.rows.length === 0) return;
    
    const poolId = updatePoolResult.rows[0].id;

    // Calculate current price
    let currentPrice = null;
    let currentPriceUsd = null;
    
    // Use the calculatePrice function following the original Megatron pattern
    currentPrice = calculatePrice(poolState);
    
    if (currentPrice && currentPrice > 0) {
      // Get SOL price for USD calculation
      const solPriceResult = await dbPool.query(
        'SELECT price_usd FROM sol_usd_prices ORDER BY price_time DESC LIMIT 1'
      );
      
      if (solPriceResult.rows.length > 0) {
        const solPrice = parseFloat(solPriceResult.rows[0].price_usd);
        currentPriceUsd = currentPrice * solPrice;
      }
    }

    // Calculate bonding curve progress based on SOL raised
    let bondingCurveProgress = 0;
    if (poolState.total_quote_fund_raising && poolState.real_quote) {
      const targetSol = parseFloat(poolState.total_quote_fund_raising) / 1e9;
      const currentSol = parseFloat(poolState.real_quote) / 1e9;
      bondingCurveProgress = Math.min(100, (currentSol / targetSol) * 100);
    }

    // Update pool in database with all relevant fields
    const updateResult = await dbPool.query(
      `UPDATE pools 
       SET status = $1, 
           real_token_reserves = $2,
           real_sol_reserves = $3,
           virtual_token_reserves = $4,
           virtual_sol_reserves = $5,
           latest_price = $6,
           latest_price_usd = $7,
           bonding_curve_progress = $8,
           base_vault = COALESCE($9, base_vault),
           quote_vault = COALESCE($10, quote_vault),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $11
       RETURNING id`,
      [
        poolState.status === 0 ? 'active' : 'graduated',
        poolState.real_base || '0',
        poolState.real_quote || '0',
        poolState.virtual_base || '0',
        poolState.virtual_quote || '0',
        currentPrice?.toString() || null,
        currentPriceUsd?.toString() || null,
        bondingCurveProgress.toFixed(2),
        poolState.base_vault || null,
        poolState.quote_vault || null,
        poolId
      ]
    );

    if (updateResult.rowCount && updateResult.rowCount > 0) {
      console.log(`💾 Pool updated in database: ${accountData.pubKey}`);
      console.log(`   Status: ${poolState.status === 0 ? 'active' : 'graduated'}`);
      console.log(`   Real Reserves: ${poolState.real_base} tokens / ${poolState.real_quote} quote`);
      console.log(`   Virtual Reserves: ${poolState.virtual_base} tokens / ${poolState.virtual_quote} SOL`);
      if (currentPrice) {
        console.log(`   Current Price: ${currentPrice.toExponential(6)} SOL ($${currentPriceUsd?.toFixed(6) || 'N/A'} USD)`);
        console.log(`   Progress: ${bondingCurveProgress.toFixed(2)}%`);
      }
    }

  } catch (error: any) {
    console.error(`❌ Failed to update pool in database:`, error.message || error);
    if (error.message?.includes('Cannot use a pool after calling end')) {
      console.log(`   Database pool was closed. Monitor will reconnect on next update.`);
    } else if (error.code === '23505') {
      console.log(`   Duplicate key error - pool might be processing concurrently`);
    } else if (error.code === '23503') {
      console.log(`   Foreign key error - related token might not exist`);
    } else if (error.code === 'ECONNREFUSED') {
      console.log(`   Database connection refused - check if database is running`);
    }
  }
}

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("Starting Stream...");
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

  stream.on("data", async (data) => {
    if (isShuttingDown) return;
    
    try {
      const parsed_launchpad_account = await decodeRaydiumLaunchpadTxnData(data);
      if (!parsed_launchpad_account) return;
      
      console.log("\n========== RAYDIUM LAUNCHPAD ACCOUNT UPDATE ==========");
      console.log(parsed_launchpad_account);
      console.log("=====================================================\n");
      
      // Process pool updates if it's a pool state account
      if (parsed_launchpad_account.parsedAccount?.base_mint) {
        await processPoolUpdate(parsed_launchpad_account);
      }
      
    } catch (error) {
      if (error) {
        console.log(error);
      }
    }
  });
  
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
  console.log("Raydium Launchpad Account Monitor V3 (Shyft Example)");
  console.log("====================================================");
  console.log("Program ID:", RAYDIUM_LAUNCHPAD_PROGRAM_ID);
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
  process.env.X_TOKEN,
  undefined,
);

const req: SubscribeRequest = {
  "slots": {},
  "accounts": {
    "raydium_launchpad": {
      "account": [],
      "filters": [],
      "owner": [RAYDIUM_LAUNCHPAD_PROGRAM_ID]
    }
  },
  "transactions": {},
  "blocks": {},
  "blocksMeta": {},
  "accountsDataSlice": [],
  "commitment": CommitmentLevel.PROCESSED,
  entry: {},
  transactionsStatus: {}
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⚠️  Shutting down gracefully...');
  isShuttingDown = true;
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️  Shutting down gracefully...');
  isShuttingDown = true;
  setTimeout(() => process.exit(0), 1000);
});

subscribeCommand(client, req);