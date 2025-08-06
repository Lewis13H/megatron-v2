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
import base58 from "bs58";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import raydiumLaunchpadIdl from "./idls/raydium_launchpad.json";
import { getDbPool } from "../../database";

const RAYDIUM_LAUNCHPAD_PROGRAM_ID = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const coder = new BorshAccountsCoder(raydiumLaunchpadIdl as Idl);

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

function base64ToBase58(data: string) {
  return base58.encode(Buffer.from(data, 'base64'));
}

async function decodeRaydiumLaunchpadAccountData(data: any) {
  if (!data || !data.account || !data.account.account) return;

  const accountData = data.account.account;

  const signature = accountData.txnSignature ? base64ToBase58(accountData.txnSignature) : null;
  const pubKey = accountData.pubkey ? base64ToBase58(accountData.pubkey) : null;
  const owner = accountData.owner ? base64ToBase58(accountData.owner) : null;
  const slot = data.account.slot;

  let parsedAccount;
  try {
    parsedAccount = coder.decodeAny(accountData?.data);
    bnLayoutFormatter(parsedAccount);
  } catch (error) {
    console.error("Failed to decode pool state:", error);
    return null;
  }

  return {
    signature,
    pubKey,
    owner,
    slot,
    parsedAccount,
    timestamp: new Date().toISOString()
  };
}

function displayAccountUpdate(accountData: any) {
  console.log("\n========== RAYDIUM LAUNCHPAD ACCOUNT UPDATE ==========");
  console.log(`Signature: ${accountData.signature || 'N/A'}`);
  console.log(`Account: ${accountData.pubKey}`);
  console.log(`Owner: ${accountData.owner}`);
  console.log(`Slot: ${accountData.slot}`);
  console.log(`Time: ${accountData.timestamp}`);
  
  if (accountData.parsedAccount) {
    console.log("\nParsed Account Data:");
    console.log(JSON.stringify(accountData.parsedAccount, null, 2));
    
    // Identify account type
    if (accountData.parsedAccount.base_mint) {
      console.log("\n🏊 Pool State Account Detected");
    } else if (accountData.parsedAccount.authority) {
      console.log("\n🔐 Authority Account Detected");
    } else {
      console.log("\n❓ Unknown Account Type");
    }
  }
  console.log("=====================================================\n");
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
        console.log(`   Token ${poolState.base_mint} not found either. Run mint monitor first.`);
        return;
      }
      
      console.log(`   Token found but pool not created yet. This account update will be processed later.`);
      return;
    }

    const poolId = poolResult.rows[0].id;

    // Calculate current price from real reserves
    let currentPrice = null;
    let currentPriceUsd = null;
    
    if (poolState.real_base && poolState.real_quote && parseFloat(poolState.real_base) > 0) {
      const realTokenReserves = parseFloat(poolState.real_base);
      const realSolReserves = parseFloat(poolState.real_quote);
      
      // Price calculation: SOL has 9 decimals, tokens have 6 decimals
      currentPrice = (realSolReserves / 1e9) / (realTokenReserves / 1e6);
      
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

    // Update pool in database
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
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
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
        poolId
      ]
    );

    if (updateResult.rowCount && updateResult.rowCount > 0) {
      console.log(`💾 Pool updated in database: ${accountData.pubKey}`);
      if (currentPrice) {
        console.log(`   Price: ${currentPrice.toExponential(6)} SOL ($${currentPriceUsd?.toFixed(6) || 'N/A'})`);
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
    if (isShuttingDown) return; // Skip processing if shutting down
    
    try {
      const parsed_account = await decodeRaydiumLaunchpadAccountData(data);
      if (!parsed_account) return;
      
      displayAccountUpdate(parsed_account);
      
      // Process pool updates if it's a pool state account
      if (parsed_account.parsedAccount?.base_mint && !isShuttingDown) {
        await processPoolUpdate(parsed_account);
      }
      
    } catch (error) {
      console.error("Error processing account update:", error);
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
  console.log("Raydium Launchpad Account Monitor V2");
  console.log("=====================================");
  console.log("Program ID:", RAYDIUM_LAUNCHPAD_PROGRAM_ID);
  console.log("Monitoring all account updates...\n");
  
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
  slots: {},
  accounts: {
    raydium_launchpad: {
      account: [],
      filters: [],
      owner: [RAYDIUM_LAUNCHPAD_PROGRAM_ID]
    }
  },
  transactions: {},
  blocks: {},
  blocksMeta: {},
  accountsDataSlice: [],
  commitment: CommitmentLevel.PROCESSED,
  entry: {},
  transactionsStatus: {}
};

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⚠️  Shutting down gracefully...');
  isShuttingDown = true;
  // Don't close the database pool here - let the main process handler do it
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️  Shutting down gracefully...');
  isShuttingDown = true;
  setTimeout(() => process.exit(0), 1000);
});

subscribeCommand(client, req);