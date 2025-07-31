import { getDbPool } from './connection';
import { Connection, PublicKey } from '@solana/web3.js';

async function checkPoolOwnership() {
  const dbPool = getDbPool();
  const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
  
  try {
    // Get a few pool addresses from database
    const poolsQuery = `
      SELECT pool_address, t.mint_address, t.symbol
      FROM pools p
      JOIN tokens t ON p.token_id = t.id
      WHERE p.platform = 'raydium_launchpad'
      LIMIT 5
    `;
    
    const result = await dbPool.query(poolsQuery);
    
    if (result.rows.length === 0) {
      console.log('No Raydium Launchpad pools found in database');
      return;
    }
    
    console.log('=== Checking Pool Account Ownership ===\n');
    
    for (const pool of result.rows) {
      try {
        const poolPubkey = new PublicKey(pool.pool_address);
        const accountInfo = await connection.getAccountInfo(poolPubkey);
        
        if (!accountInfo) {
          console.log(`Pool ${pool.pool_address} - Account not found on chain`);
          continue;
        }
        
        console.log(`Pool: ${pool.pool_address}`);
        console.log(`Token: ${pool.symbol || 'Unknown'} (${pool.mint_address})`);
        console.log(`Owner: ${accountInfo.owner.toBase58()}`);
        console.log(`Expected: ${RAYDIUM_LAUNCHPAD_PROGRAM_ID}`);
        console.log(`Match: ${accountInfo.owner.toBase58() === RAYDIUM_LAUNCHPAD_PROGRAM_ID ? '✅ YES' : '❌ NO'}`);
        console.log(`Data Length: ${accountInfo.data.length} bytes`);
        console.log('---\n');
        
      } catch (error) {
        console.error(`Error checking pool ${pool.pool_address}:`, error);
      }
    }
    
  } catch (error) {
    console.error('Error checking pool ownership:', error);
  } finally {
    await dbPool.end();
  }
}

const RAYDIUM_LAUNCHPAD_PROGRAM_ID = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';

// Run the check
checkPoolOwnership();