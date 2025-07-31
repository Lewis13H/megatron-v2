import { getDbPool } from './connection';

async function checkRecentPools() {
  const pool = getDbPool();
  
  try {
    // Check all pools with their details
    const poolsQuery = `
      SELECT 
        p.pool_address,
        p.platform,
        p.status,
        p.created_at,
        p.updated_at,
        t.mint_address,
        t.symbol,
        t.name
      FROM pools p
      JOIN tokens t ON p.token_id = t.id
      -- WHERE p.platform = 'raydium_launchpad'
      ORDER BY p.created_at DESC
    `;
    
    const result = await pool.query(poolsQuery);
    
    console.log('=== Raydium Launchpad Pools ===');
    console.log(`Total pools: ${result.rows.length}\n`);
    
    result.rows.forEach((pool, index) => {
      console.log(`${index + 1}. ${pool.symbol || 'Unknown'} (${pool.mint_address})`);
      console.log(`   Pool Address: ${pool.pool_address}`);
      console.log(`   Status: ${pool.status}`);
      console.log(`   Created: ${new Date(pool.created_at).toISOString()}`);
      console.log(`   Updated: ${new Date(pool.updated_at).toISOString()}`);
      console.log(`   Has Updates: ${pool.updated_at > pool.created_at ? 'YES' : 'NO'}\n`);
    });
    
    // Show the specific pool addresses we should be monitoring
    console.log('=== Pool Addresses to Monitor ===');
    result.rows.forEach(pool => {
      console.log(`- ${pool.pool_address}`);
    });
    
  } catch (error) {
    console.error('Error checking pools:', error);
  } finally {
    await pool.end();
  }
}

// Run the check
checkRecentPools();