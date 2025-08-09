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
import { PublicKey } from "@solana/web3.js";
import { decodeRaydiumLaunchpadAccountData } from "./utils/raydium-launchpad-account-processor";
import { getDbPool, PoolOperations, PoolData, Pool } from "../../database";
import { grpcPool } from '../../grpc';  // ADDED: Import pool

const RAYDIUM_LAUNCHPAD_PROGRAM_ID = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';

// Global shutdown flag
let isShuttingDown = false;

// Raydium LaunchLab Mechanics (Updated based on UI evidence)
// - Bonding Curve Progress: Based on SOL raised / target (85 SOL), NOT token sales
// - Token Allocation: Standard is 79.31% for bonding curve, 20.69% reserved
// - total_base_sell: Total tokens for sale (typically 793.1M = 79.31% of 1B supply)
// - real_base: Current tokens remaining in pool
// - real_quote: Current SOL in pool (use for progress calculation)
// - total_quote_fund_raising: Target SOL to raise (typically 85 SOL)
// - Virtual reserves: Used for price calculation (constant product AMM)
// - Graduation: Occurs when SOL target is reached, not when tokens sell out

// Initialize database operations
const dbPool = getDbPool();
const poolOperations = new PoolOperations();

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

async function handleStream(client: Client, args: SubscribeRequest, monitorId: string) {
  console.log("Starting Raydium Launchpad Account Monitor (Pooled)...")
  const stream = await client.subscribe();
  
  // ADDED: Register stream with the pool for proper cleanup
  (grpcPool as any).setStream(monitorId, stream);

  const streamClosed = new Promise<void>((resolve, reject) => {
    stream.on("error", (error: any) => {
      // UPDATED: Handle cancellation errors gracefully
      if (error.code === 1 || error.message?.includes('Cancelled')) {
        console.log("✅ Stream cancelled gracefully");
        resolve();
      } else {
        console.log("ERROR", error);
        reject(error);
      }
    });
    stream.on("end", () => {
      resolve();
    });
    stream.on("close", () => {
      resolve();
    });
  });

  stream.on("data", async (data) => {
    try {
      console.log("📡 Received account update...");
      
      const parsedLaunchpadAccount = await decodeRaydiumLaunchpadAccountData(data);
      if (!parsedLaunchpadAccount) {
        console.log("❌ Failed to parse account data");
        return;
      }
      
      console.log("✅ Account parsed successfully");
      console.log(`   - Account: ${parsedLaunchpadAccount.pubKey}`);
      console.log(`   - Owner: ${parsedLaunchpadAccount.owner}`);
      console.log("   Account type detection:");
      console.log(`   - Account type from decoder: ${parsedLaunchpadAccount.accountType}`);
      console.log(`   - Has discriminator: ${!!parsedLaunchpadAccount.parsedAccount?.discriminator}`);
      console.log(`   - Discriminator value: ${parsedLaunchpadAccount.parsedAccount?.discriminator}`);
      console.log(`   - Has accountType: ${!!parsedLaunchpadAccount.parsedAccount?.accountType}`);
      console.log(`   - AccountType value: ${parsedLaunchpadAccount.parsedAccount?.accountType}`);
      console.log(`   - Has base_mint: ${!!parsedLaunchpadAccount.parsedAccount?.base_mint}`);
      console.log(`   - Has quote_mint: ${!!parsedLaunchpadAccount.parsedAccount?.quote_mint}`);
      console.log(`   - Has base_vault: ${!!parsedLaunchpadAccount.parsedAccount?.base_vault}`);
      
      // Display the update
      displayAccountUpdate(parsedLaunchpadAccount);
      
      // Save to database if it's a PoolState account
      // The parsed account data has the fields directly at the root level
      const parsedData = parsedLaunchpadAccount.parsedAccount;
      const isPoolState = !!(
        parsedData && 
        parsedData.base_mint && 
        parsedData.quote_mint &&
        parsedData.base_vault &&
        parsedData.quote_vault &&
        parsedData.real_base !== undefined &&
        parsedData.real_quote !== undefined
      );
      
      console.log(`🔍 Is PoolState: ${isPoolState}`);
      
      if (isPoolState) {
        console.log("💾 Attempting to save PoolState to database...");
        await savePoolStateToDatabase(parsedLaunchpadAccount);
      } else {
        console.log("⏭️  Not a PoolState account, skipping database save");
      }
    } catch (error) {
      console.error("❌ Error processing account data:", error);
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

function displayAccountUpdate(accountData: any) {
  const { signature, pubKey, owner, parsedAccount, accountType: decoderAccountType } = accountData;
  
  // Determine account type
  let accountType = decoderAccountType || 'Unknown';
  if (!accountType || accountType === 'Unknown') {
    if (parsedAccount?.discriminator) {
      accountType = parsedAccount.discriminator;
    } else if (parsedAccount?.type) {
      accountType = parsedAccount.type;
    } else if (parsedAccount?.accountType) {
      accountType = parsedAccount.accountType;
    } else if (parsedAccount?.baseMint && parsedAccount?.quoteMint) {
      accountType = 'PoolState (inferred)';
    }
  }
  
  console.log(`\n${'='.repeat(100)}`);
  console.log(`🔄 RAYDIUM LAUNCHPAD ACCOUNT UPDATE`);
  console.log(`   Account Type: ${accountType}`);
  console.log(`   Account: ${pubKey}`);
  console.log(`   Owner: ${owner}`);
  console.log(`   Signature: ${signature || 'N/A'}`);
  console.log(`${'='.repeat(100)}\n`);
}

async function subscribeCommand(client: Client, args: SubscribeRequest, monitorId: string) {
  console.log("Raydium Launchpad Account Monitor (Pooled)")
  console.log("====================================================");
  console.log("Program ID:", RAYDIUM_LAUNCHPAD_PROGRAM_ID);
  console.log("Features: Real-time price and pool state updates");
  console.log("Using gRPC Connection Pool with proper stream cleanup");
  console.log("Monitoring all accounts...\n");
  
  while (!isShuttingDown) {
    try {
      await handleStream(client, args, monitorId);
    } catch (error) {
      if (!isShuttingDown) {
        console.error("Stream error, restarting in 1 second...", error);
        // ADDED: Release connection on error
        await grpcPool.releaseConnection(monitorId);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

// Function to parse decimal values with proper precision
function parseDecimalWithPrecision(value: string | any, decimals: number = 9): string {
  if (typeof value === 'string') {
    const num = parseFloat(value);
    return (num / Math.pow(10, decimals)).toFixed(9);
  } else if (value && value.toString) {
    const num = parseFloat(value.toString());
    return (num / Math.pow(10, decimals)).toFixed(9);
  }
  return '0';
}

async function savePoolStateToDatabase(accountData: any) {
  try {
    const parsedAccount = accountData.parsedAccount;
    
    // Extract key data with proper decimal handling
    const baseMint = parsedAccount.base_mint;
    const quoteMint = parsedAccount.quote_mint;
    
    // Calculate reserves with proper decimals (9 for SOL, 6 for most tokens)
    const realBase = parseDecimalWithPrecision(parsedAccount.real_base, 6);
    const realQuote = parseDecimalWithPrecision(parsedAccount.real_quote, 9);
    const virtualBase = parseDecimalWithPrecision(parsedAccount.virtual_base, 6);
    const virtualQuote = parseDecimalWithPrecision(parsedAccount.virtual_quote, 9);
    const totalBaseSell = parseDecimalWithPrecision(parsedAccount.total_base_sell, 6);
    const totalQuoteFundRaising = parseDecimalWithPrecision(parsedAccount.total_quote_fund_raising, 9);
    
    // Calculate price (SOL per token)
    const price = parseFloat(virtualQuote) > 0 && parseFloat(virtualBase) > 0 
      ? parseFloat(virtualQuote) / parseFloat(virtualBase)
      : 0;
    
    // Calculate progress based on SOL raised (real_quote) / target
    const progressPercentage = parseFloat(totalQuoteFundRaising) > 0
      ? (parseFloat(realQuote) / parseFloat(totalQuoteFundRaising)) * 100
      : 0;
    
    console.log("📊 Pool State Update:");
    console.log(`   - Base Mint: ${baseMint}`);
    console.log(`   - Quote Mint: ${quoteMint}`);
    console.log(`   - Real Base (tokens): ${realBase}`);
    console.log(`   - Real Quote (SOL): ${realQuote}`);
    console.log(`   - Virtual Base: ${virtualBase}`);
    console.log(`   - Virtual Quote: ${virtualQuote}`);
    console.log(`   - Price (SOL/token): ${price.toFixed(9)}`);
    console.log(`   - Progress: ${progressPercentage.toFixed(2)}%`);
    console.log(`   - Status: ${parsedAccount.status}`);
    
    // Find the pool and token in database
    const tokenQuery = await dbPool.query(
      'SELECT id FROM tokens WHERE mint_address = $1',
      [baseMint]
    );
    
    if (tokenQuery.rows.length === 0) {
      console.log(`⚠️ Token ${baseMint} not found in database. Skipping pool update.`);
      return;
    }
    
    const tokenId = tokenQuery.rows[0].id;
    
    // Check if pool exists
    const poolQuery = await dbPool.query(
      'SELECT id FROM pools WHERE pool_address = $1',
      [accountData.pubKey]
    );
    
    if (poolQuery.rows.length === 0) {
      console.log(`⚠️ Pool ${accountData.pubKey} not found in database. Will create it.`);
      
      // Create the pool (using Pool interface, not PoolData)
      const poolData: Omit<Pool, 'id'> = {
        pool_address: accountData.pubKey,
        token_id: tokenId,
        base_mint: baseMint,
        quote_mint: quoteMint,
        platform: 'raydium_launchpad',
        base_vault: parsedAccount.base_vault,
        quote_vault: parsedAccount.quote_vault,
        lp_mint: parsedAccount.lp_mint,
        virtual_sol_reserves: virtualQuote,
        virtual_token_reserves: virtualBase,
        real_sol_reserves: realQuote,
        real_token_reserves: realBase,
        initial_base_liquidity: realBase,
        initial_quote_liquidity: realQuote,
        bonding_curve_progress: progressPercentage,
        latest_price: price.toString(),
        latest_price_usd: '0' // Will be calculated by trigger
      };
      
      await poolOperations.create(poolData);
      console.log(`✅ Pool created successfully`);
    } else {
      // Update existing pool using raw SQL
      const poolId = poolQuery.rows[0].id;
      
      const updateQuery = `
        UPDATE pools SET
          virtual_sol_reserves = $1,
          virtual_token_reserves = $2,
          real_sol_reserves = $3,
          real_token_reserves = $4,
          bonding_curve_progress = $5,
          latest_price = $6,
          status = $7,
          updated_at = NOW()
        WHERE id = $8
      `;
      
      await dbPool.query(updateQuery, [
        virtualQuote,
        virtualBase,
        realQuote,
        realBase,
        progressPercentage,
        price,
        getPoolStatus(parsedAccount.status),
        poolId
      ]);
      
      console.log(`✅ Pool updated successfully`);
    }
    
  } catch (error: any) {
    if (error.message?.includes('Token not found')) {
      console.log(`⏳ Token ${accountData.parsedAccount.base_mint} not yet in database. Pool will be saved when token is added.`);
    } else {
      console.error(`❌ Failed to save pool state to database:`, error.message);
    }
  }
}

function getPoolStatus(statusCode: number): string {
  // Map Raydium status codes to our database status values
  switch (statusCode) {
    case 0: return 'active';     // funding = active
    case 1: return 'active';     // migrate = active (preparing to graduate)
    case 2: return 'graduated';  // trading = graduated (migrated to full AMM)
    default: return 'active';
  }
}

// CHANGED: Use pool instead of creating new client
const MONITOR_ID = 'raydium-launchpad-account-monitor';

// ADDED: Function to get client from pool
async function getPooledClient(): Promise<Client> {
  return await grpcPool.getConnection(MONITOR_ID);
}

// Handle graceful shutdown
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('\n⏹️  Shutting down monitor gracefully...');
  try {
    // Close database pool
    await dbPool.end();
    console.log('✅ Database connections closed');
    
    // ADDED: Release connection from pool
    await grpcPool.releaseConnection(MONITOR_ID);
    console.log('✅ gRPC pool connection released');
    
    // Exit cleanly
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Handle Ctrl+C
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown();
});

// ADDED: Main async function to use pool
async function main() {
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

  // Start monitoring
  console.log("Starting Raydium Launchpad Account Monitor (Pooled)");
  console.log(`Connected via gRPC Pool`);
  console.log(`Program ID: ${RAYDIUM_LAUNCHPAD_PROGRAM_ID}`);
  console.log("Monitoring: ALL accounts owned by Raydium Launchpad program\n");

  // CHANGED: Get client from pool instead of creating new one
  const client = await getPooledClient();
  
  // Run the subscription
  await subscribeCommand(client, req, MONITOR_ID);
}

// CHANGED: Call main() instead of subscribeCommand directly
main().catch(error => {
  console.error('Monitor failed:', error);
  process.exit(1);
});