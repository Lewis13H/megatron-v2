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
import { getDbPool, PoolOperations, PoolData } from "../../database";

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

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("Starting Raydium Launchpad Account Monitor...")
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
  
  console.log(`
Raydium Launchpad Account Update
========================================
Signature: ${signature || 'N/A'}
Account: ${pubKey}
Owner: ${owner}
Type: ${accountType}
Time: ${new Date().toISOString()}

Account Data:
${JSON.stringify(parsedAccount, null, 2)}
========================================
`);
}

async function subscribeCommand(client: Client, args: SubscribeRequest) {
  while (!isShuttingDown) {
    try {
      await handleStream(client, args);
    } catch (error) {
      if (!isShuttingDown) {
        console.error("Stream error, restarting in 1 second...", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

const client = new Client(
  process.env.GRPC_URL!,
  process.env.X_TOKEN!,
  undefined,
);


async function savePoolStateToDatabase(accountData: any) {
  const { pubKey, parsedAccount } = accountData;
  
  if (!parsedAccount || !pubKey) {
    console.log("⚠️  Invalid pool state data, skipping database save");
    return;
  }

  try {
    // The pool state account contains comprehensive pool data
    const poolState = parsedAccount;
    
    // Check if we already have this pool
    const existingPool = await poolOperations.getPoolWithToken(pubKey);
    
    if (existingPool) {
      // Update pool reserves and status
      const updateData: any = {
        status: getPoolStatus(poolState.status),
        updated_at: new Date()
      };
      
      // Update real reserves (field names use underscores in the decoded data)
      if (poolState.real_base !== undefined) {
        updateData.real_token_reserves = poolState.real_base;
      }
      if (poolState.real_quote !== undefined) {
        updateData.real_sol_reserves = poolState.real_quote;
      }
      
      // Update virtual reserves
      if (poolState.virtual_base !== undefined) {
        updateData.virtual_token_reserves = poolState.virtual_base;
      }
      if (poolState.virtual_quote !== undefined) {
        updateData.virtual_sol_reserves = poolState.virtual_quote;
      }
      
      // Calculate current price from real reserves
      // For Raydium Launchpad, the actual price is determined by real reserves in the pool
      if (poolState.real_base && poolState.real_quote && parseFloat(poolState.real_base) > 0) {
        // Use real reserves for current spot price
        const realTokenReserves = parseFloat(poolState.real_base);
        const realSolReserves = parseFloat(poolState.real_quote);
        
        // Calculate current price from real reserves
        // SOL has 9 decimals, tokens have 6 decimals
        const priceInSol = (realSolReserves / 1e9) / (realTokenReserves / 1e6);
        updateData.latest_price = priceInSol.toString();
        
        // Calculate initial price from virtual reserves for comparison
        if (poolState.virtual_base && poolState.virtual_quote) {
          const virtualTokenReserves = parseFloat(poolState.virtual_base);
          const virtualSolReserves = parseFloat(poolState.virtual_quote);
          const initialPrice = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6);
          const priceMultiplier = priceInSol / initialPrice;
          
          console.log(`   Initial price: ${initialPrice.toExponential(6)} SOL per token`);
          console.log(`   Current price: ${priceInSol.toExponential(6)} SOL per token`);
          console.log(`   Price multiplier: ${priceMultiplier.toFixed(2)}x from initial`);
        }
        
        // Log token sales progress
        if (poolState.total_base_sell) {
          const totalBaseSell = parseFloat(poolState.total_base_sell);
          const tokensSold = totalBaseSell - realTokenReserves;
          console.log(`   Tokens sold: ${(tokensSold / 1e6).toFixed(2)}M / ${(totalBaseSell / 1e6).toFixed(2)}M (${((tokensSold / totalBaseSell) * 100).toFixed(2)}%)`);
        }
      } else if (poolState.virtual_base && poolState.virtual_quote) {
        // Fallback to virtual reserves for initial price (when no trading has occurred)
        const virtualTokenReserves = parseFloat(poolState.virtual_base);
        const virtualSolReserves = parseFloat(poolState.virtual_quote);
        const initialPrice = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6);
        updateData.latest_price = initialPrice.toString();
        
        console.log(`   Initial price (no trades yet): ${initialPrice.toExponential(6)} SOL per token`);
      }
      
      // Calculate USD price if SOL price is available
      if (updateData.latest_price) {
        try {
          const solPriceResult = await dbPool.query(
            'SELECT price_usd FROM sol_usd_prices ORDER BY price_time DESC LIMIT 1'
          );
          if (solPriceResult.rows.length > 0) {
            const solPrice = parseFloat(solPriceResult.rows[0].price_usd);
            const priceInUsd = parseFloat(updateData.latest_price) * solPrice;
            updateData.latest_price_usd = priceInUsd.toString();
          }
        } catch (error) {
          console.error('Error fetching SOL price:', error);
        }
      }
      
      // Calculate bonding curve progress based on SOL raised
      // For Raydium Launchpad, graduation is based on reaching the SOL target (85 SOL)
      if (poolState.total_quote_fund_raising && poolState.real_quote) {
        const targetSol = parseFloat(poolState.total_quote_fund_raising) / 1e9;
        const currentSol = parseFloat(poolState.real_quote) / 1e9;
        const solProgress = (currentSol / targetSol) * 100;
        
        // Use SOL-based progress as the primary metric for Raydium
        const clampedProgress = Math.max(0, Math.min(100, solProgress));
        updateData.bonding_curve_progress = clampedProgress.toFixed(2);
        
        console.log(`   Bonding Curve Progress: ${clampedProgress.toFixed(2)}% (SOL raised)`);
        console.log(`   SOL raised: ${currentSol.toFixed(2)} / ${targetSol.toFixed(2)} SOL`);
        
        // Also show token progress for reference
        if (poolState.real_base && poolState.total_base_sell) {
          const currentRealTokens = parseFloat(poolState.real_base);
          const totalBaseSell = parseFloat(poolState.total_base_sell);
          const tokensSold = totalBaseSell - currentRealTokens;
          const tokenProgress = (tokensSold / totalBaseSell) * 100;
          
          console.log(`   Tokens sold: ${(tokensSold / 1e6).toFixed(2)}M / ${(totalBaseSell / 1e6).toFixed(2)}M (${tokenProgress.toFixed(2)}%)`);
          
          // Log a warning if there's a large discrepancy
          if (Math.abs(tokenProgress - solProgress) > 50) {
            console.log(`   ⚠️  Large discrepancy between token progress (${tokenProgress.toFixed(1)}%) and SOL progress (${solProgress.toFixed(1)}%)`);
            console.log(`   This may indicate the pool started with fewer tokens than total_base_sell`);
          }
        }
      } else {
        console.log(`   Warning: Missing total_quote_fund_raising or real_quote - cannot calculate bonding curve progress`);
      }
      
      await dbPool.query(
        `UPDATE pools 
         SET status = $1, 
             real_token_reserves = COALESCE($2, real_token_reserves),
             real_sol_reserves = COALESCE($3, real_sol_reserves),
             virtual_token_reserves = COALESCE($4, virtual_token_reserves),
             virtual_sol_reserves = COALESCE($5, virtual_sol_reserves),
             latest_price = COALESCE($6, latest_price),
             latest_price_usd = COALESCE($7, latest_price_usd),
             bonding_curve_progress = COALESCE($8, bonding_curve_progress),
             updated_at = $9
         WHERE pool_address = $10`,
        [
          updateData.status,
          updateData.real_token_reserves,
          updateData.real_sol_reserves,
          updateData.virtual_token_reserves,
          updateData.virtual_sol_reserves,
          updateData.latest_price,
          updateData.latest_price_usd,
          updateData.bonding_curve_progress,
          updateData.updated_at,
          pubKey
        ]
      );
      
      console.log(`💾 Pool state updated in database: ${pubKey}`);
      console.log(`   Status: ${updateData.status}`);
      console.log(`   Real Reserves: ${poolState.real_base} tokens / ${poolState.real_quote} quote`);
      console.log(`   Virtual Reserves: ${poolState.virtual_base} tokens / ${poolState.virtual_quote} SOL`);
      if (updateData.latest_price) {
        console.log(`   Current Price: ${updateData.latest_price} SOL${updateData.latest_price_usd ? ` ($${updateData.latest_price_usd} USD)` : ''}`);
      }
    } else {
      // New pool - save full data
      const poolData: PoolData = {
        pool_address: pubKey,
        base_mint: poolState.base_mint,
        quote_mint: poolState.quote_mint,
        platform: 'raydium_launchpad' as const,
        base_vault: poolState.base_vault,
        quote_vault: poolState.quote_vault,
        initial_base_liquidity: poolState.real_base,
        initial_quote_liquidity: poolState.real_quote,
        real_token_reserves: poolState.real_base,
        real_sol_reserves: poolState.real_quote,
        virtual_token_reserves: poolState.virtual_base,
        virtual_sol_reserves: poolState.virtual_quote
      };
      
      await poolOperations.insertPoolWithToken(poolData, poolState.base_mint);
      console.log(`💾 New pool saved to database: ${pubKey}`);
      console.log(`   Base Mint: ${poolState.base_mint}`);
      console.log(`   Quote Mint: ${poolState.quote_mint}`);
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

// Start monitoring
console.log("Starting Raydium Launchpad Account Monitor");
console.log(`Connected to: ${process.env.GRPC_URL}`);
console.log(`Program ID: ${RAYDIUM_LAUNCHPAD_PROGRAM_ID}`);
console.log("Monitoring: ALL accounts owned by Raydium Launchpad program\n");

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

// Handle graceful shutdown
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('\n⏹️  Shutting down monitor gracefully...');
  try {
    // Close database pool
    await dbPool.end();
    console.log('✅ Database connections closed');
    
    // Close gRPC client
    // client.close();  // close() method might not exist on Client
    console.log('✅ gRPC client connection will be terminated');
    
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

subscribeCommand(client, req);