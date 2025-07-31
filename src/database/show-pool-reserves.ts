import { getDbPool } from './connection';

async function showPoolReserves() {
  const dbPool = getDbPool();
  
  try {
    const query = `
      WITH token_pool_stats AS (
        SELECT 
          t.id as token_id,
          t.mint_address,
          t.symbol,
          t.name,
          t.platform as token_platform,
          t.creation_timestamp,
          t.is_graduated,
          p.id as pool_id,
          p.pool_address,
          p.platform as pool_platform,
          p.status as pool_status,
          p.real_sol_reserves,
          p.real_token_reserves,
          p.virtual_sol_reserves,
          p.virtual_token_reserves,
          p.created_at as pool_created_at,
          p.updated_at as pool_updated_at,
          -- Calculate if pool has been updated by account monitor
          CASE 
            WHEN p.updated_at > p.created_at THEN TRUE 
            ELSE FALSE 
          END as pool_has_updates,
          -- Calculate current price if reserves exist
          CASE 
            WHEN p.real_token_reserves > 0 AND p.real_token_reserves IS NOT NULL 
            THEN p.real_sol_reserves::numeric / p.real_token_reserves::numeric 
            ELSE NULL 
          END as current_price_from_reserves
        FROM tokens t
        LEFT JOIN pools p ON t.id = p.token_id
        WHERE t.platform = 'raydium_launchpad' OR p.platform = 'raydium_launchpad'
      )
      SELECT 
        mint_address,
        symbol,
        name,
        pool_address,
        pool_status,
        real_sol_reserves,
        real_token_reserves,
        virtual_sol_reserves,
        virtual_token_reserves,
        pool_has_updates,
        current_price_from_reserves,
        pool_created_at,
        pool_updated_at
      FROM token_pool_stats
      WHERE pool_address IS NOT NULL
      ORDER BY pool_updated_at DESC NULLS LAST
      LIMIT 20;
    `;
    
    const result = await dbPool.query(query);
    
    console.log('\n=== RAYDIUM LAUNCHPAD POOL RESERVES ===\n');
    console.log(`Found ${result.rows.length} pools with data\n`);
    
    for (const row of result.rows) {
      console.log(`Token: ${row.symbol || 'Unknown'} (${row.name || 'Unnamed'})`);
      console.log(`Mint: ${row.mint_address}`);
      console.log(`Pool: ${row.pool_address}`);
      console.log(`Status: ${row.pool_status}`);
      console.log(`\nReserves:`);
      console.log(`  Real SOL: ${row.real_sol_reserves || 'null'}`);
      console.log(`  Real Tokens: ${row.real_token_reserves || 'null'}`);
      console.log(`  Virtual SOL: ${row.virtual_sol_reserves || 'null'}`);
      console.log(`  Virtual Tokens: ${row.virtual_token_reserves || 'null'}`);
      console.log(`\nPrice from reserves: ${row.current_price_from_reserves ? row.current_price_from_reserves.toFixed(10) : 'N/A'}`);
      console.log(`Pool has updates: ${row.pool_has_updates ? '✅ YES' : '❌ NO'}`);
      console.log(`Created: ${row.pool_created_at}`);
      console.log(`Updated: ${row.pool_updated_at}`);
      console.log('\n' + '='.repeat(60) + '\n');
    }
    
    // Summary statistics
    const summaryQuery = `
      SELECT 
        COUNT(DISTINCT t.id) as total_tokens,
        COUNT(DISTINCT p.id) as total_pools,
        COUNT(DISTINCT CASE WHEN p.real_sol_reserves IS NOT NULL THEN p.id END) as pools_with_reserves,
        COUNT(DISTINCT CASE WHEN p.updated_at > p.created_at THEN p.id END) as pools_with_updates
      FROM tokens t
      LEFT JOIN pools p ON t.id = p.token_id
      WHERE t.platform = 'raydium_launchpad' OR p.platform = 'raydium_launchpad';
    `;
    
    const summary = await dbPool.query(summaryQuery);
    const stats = summary.rows[0];
    
    console.log('SUMMARY STATISTICS:');
    console.log(`Total tokens: ${stats.total_tokens}`);
    console.log(`Total pools: ${stats.total_pools}`);
    console.log(`Pools with reserve data: ${stats.pools_with_reserves}`);
    console.log(`Pools with updates: ${stats.pools_with_updates}`);
    
  } catch (error) {
    console.error('Error fetching pool reserves:', error);
  } finally {
    await dbPool.end();
  }
}

// Run the script
showPoolReserves();