import { getDbPool } from './connection';

async function checkVirtualReserves() {
  const dbPool = getDbPool();
  
  try {
    // First check if virtual reserves are all the same
    const uniqueQuery = `
      SELECT 
        COUNT(DISTINCT virtual_sol_reserves) as unique_sol_values,
        COUNT(DISTINCT virtual_token_reserves) as unique_token_values,
        MIN(virtual_sol_reserves) as min_sol,
        MAX(virtual_sol_reserves) as max_sol,
        MIN(virtual_token_reserves) as min_token,
        MAX(virtual_token_reserves) as max_token
      FROM pools
      WHERE platform = 'raydium_launchpad'
        AND virtual_sol_reserves IS NOT NULL;
    `;
    
    const uniqueResult = await dbPool.query(uniqueQuery);
    console.log('\n=== VIRTUAL RESERVES ANALYSIS ===');
    console.log(`Unique SOL reserve values: ${uniqueResult.rows[0].unique_sol_values}`);
    console.log(`Unique Token reserve values: ${uniqueResult.rows[0].unique_token_values}`);
    console.log(`SOL range: ${uniqueResult.rows[0].min_sol} to ${uniqueResult.rows[0].max_sol}`);
    console.log(`Token range: ${uniqueResult.rows[0].min_token} to ${uniqueResult.rows[0].max_token}`);
    
    // Now check some specific pools
    const query = `
      SELECT 
        pool_address,
        virtual_sol_reserves,
        virtual_token_reserves,
        real_sol_reserves,
        real_token_reserves,
        CASE 
          WHEN virtual_token_reserves > 0 
          THEN (virtual_sol_reserves::numeric / 1e9) / (virtual_token_reserves::numeric / 1e6)
          ELSE NULL 
        END as calculated_price,
        updated_at
      FROM pools
      WHERE platform = 'raydium_launchpad'
        AND virtual_sol_reserves IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 5;
    `;
    
    const result = await dbPool.query(query);
    
    console.log('\n=== SAMPLE VIRTUAL RESERVES ===\n');
    
    for (const row of result.rows) {
      console.log(`Pool: ${row.pool_address}`);
      console.log(`Virtual SOL: ${row.virtual_sol_reserves} (${(parseInt(row.virtual_sol_reserves) / 1e9).toFixed(2)} SOL)`);
      console.log(`Virtual Tokens: ${row.virtual_token_reserves} (${(parseInt(row.virtual_token_reserves) / 1e6).toFixed(2)} tokens)`);
      console.log(`Real SOL: ${row.real_sol_reserves} (${(parseInt(row.real_sol_reserves) / 1e9).toFixed(2)} SOL)`);
      console.log(`Real Tokens: ${row.real_token_reserves} (${(parseInt(row.real_token_reserves) / 1e6).toFixed(2)} tokens)`);
      console.log(`Calculated Price: ${row.calculated_price ? parseFloat(row.calculated_price).toFixed(10) : 'N/A'} SOL per token`);
      console.log(`Updated: ${row.updated_at}\n`);
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbPool.end();
  }
}

checkVirtualReserves();