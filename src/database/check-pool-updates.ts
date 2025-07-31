import { getDbPool } from './connection';

async function checkPoolUpdates() {
  const pool = getDbPool();
  
  try {
    // Check pools with recent updates
    const recentUpdatesQuery = `
      SELECT 
        p.pool_address,
        t.mint_address,
        t.symbol,
        p.platform,
        p.status,
        p.real_sol_reserves,
        p.real_token_reserves,
        p.virtual_sol_reserves,
        p.virtual_token_reserves,
        p.created_at,
        p.updated_at,
        CASE 
          WHEN p.updated_at > p.created_at THEN 'YES'
          ELSE 'NO'
        END as has_been_updated
      FROM pools p
      JOIN tokens t ON p.token_id = t.id
      ORDER BY p.updated_at DESC
      LIMIT 10
    `;
    
    const result = await pool.query(recentUpdatesQuery);
    
    console.log('=== Pool Update Status ===');
    console.log(`Total pools found: ${result.rows.length}`);
    console.log('');
    
    result.rows.forEach((pool, index) => {
      console.log(`${index + 1}. ${pool.symbol || 'Unknown'} - ${pool.mint_address}`);
      console.log(`   Pool Address: ${pool.pool_address}`);
      console.log(`   Platform: ${pool.platform}`);
      console.log(`   Status: ${pool.status}`);
      console.log(`   Has Been Updated: ${pool.has_been_updated}`);
      console.log(`   Created: ${new Date(pool.created_at).toISOString()}`);
      console.log(`   Updated: ${new Date(pool.updated_at).toISOString()}`);
      
      if (pool.real_sol_reserves || pool.real_token_reserves) {
        console.log(`   Real Reserves: ${pool.real_token_reserves || 0} tokens / ${pool.real_sol_reserves || 0} SOL`);
      }
      if (pool.virtual_sol_reserves || pool.virtual_token_reserves) {
        console.log(`   Virtual Reserves: ${pool.virtual_token_reserves || 0} tokens / ${pool.virtual_sol_reserves || 0} SOL`);
      }
      console.log('');
    });
    
    // Check for pools that have been updated via account monitor
    const updatedPoolsQuery = `
      SELECT 
        COUNT(*) as total_pools,
        COUNT(CASE WHEN updated_at > created_at THEN 1 END) as updated_pools,
        COUNT(CASE WHEN real_sol_reserves IS NOT NULL THEN 1 END) as pools_with_real_reserves,
        COUNT(CASE WHEN virtual_sol_reserves IS NOT NULL THEN 1 END) as pools_with_virtual_reserves,
        COUNT(CASE WHEN status != 'active' THEN 1 END) as pools_with_status_change
      FROM pools
      WHERE platform = 'raydium_launchpad'
    `;
    
    const statsResult = await pool.query(updatedPoolsQuery);
    const stats = statsResult.rows[0];
    
    console.log('=== Raydium Launchpad Pool Statistics ===');
    console.log(`Total Pools: ${stats.total_pools}`);
    console.log(`Pools Updated: ${stats.updated_pools}`);
    console.log(`Pools with Real Reserves: ${stats.pools_with_real_reserves}`);
    console.log(`Pools with Virtual Reserves: ${stats.pools_with_virtual_reserves}`);
    console.log(`Pools with Status Change: ${stats.pools_with_status_change}`);
    
  } catch (error) {
    console.error('Error checking pool updates:', error);
  } finally {
    await pool.end();
  }
}

// Run the check
checkPoolUpdates();