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

// Initialize database operations
const dbPool = getDbPool();
const poolOperations = new PoolOperations(dbPool);

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
  undefined,
);

// We need to monitor specific pool accounts, not just by owner
// Let's add some known pool addresses to test
const testPoolAddresses = [
  "3KJNYdEsDd2m9rVTQ3J7PJhR2dFoXGA1YWCiD7FLhyo1",
  "62hxwQM7Q5XP9zJiPDyFMoDW1viPRBZBDCNjkG8P7yEW",
  "2RBWGh3NqXtiCaGMWD4dENmozTKeW67jVMniyE5PuvQJ",
  "J6NXNqbE55UyzbAHr9Da9VihjwJEvBCer1xZX8KnAEDu",
  "2yJCccA3sRYTqaSjrNKXMvcXqXGWF1t8CWtvawfz2xKz"
];

const req: SubscribeRequest = {
  "slots": {},
  "accounts": {
    "raydium_launchpad_owner": {
      "account": [],
      "filters": [],
      "owner": [RAYDIUM_LAUNCHPAD_PROGRAM_ID] 
    },
    // Also monitor specific pool accounts directly
    "raydium_pools": {
      "account": testPoolAddresses,
      "filters": [],
      "owner": []
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
      
      await dbPool.query(
        `UPDATE pools 
         SET status = $1, 
             real_token_reserves = COALESCE($2, real_token_reserves),
             real_sol_reserves = COALESCE($3, real_sol_reserves),
             virtual_token_reserves = COALESCE($4, virtual_token_reserves),
             virtual_sol_reserves = COALESCE($5, virtual_sol_reserves),
             updated_at = $6
         WHERE pool_address = $7`,
        [
          updateData.status,
          updateData.real_token_reserves,
          updateData.real_sol_reserves,
          updateData.virtual_token_reserves,
          updateData.virtual_sol_reserves,
          updateData.updated_at,
          pubKey
        ]
      );
      
      console.log(`💾 Pool state updated in database: ${pubKey}`);
      console.log(`   Status: ${updateData.status}`);
      console.log(`   Real Reserves: ${poolState.real_base} tokens / ${poolState.real_quote} quote`);
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
console.log("Monitoring: Account updates\n");

subscribeCommand(client, req);