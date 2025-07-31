import { getDbPool } from './connection';

async function showPoolsWithReserves() {
  const dbPool = getDbPool();
  
  try {
    const query = `
      SELECT 
        t.mint_address,
        t.symbol,
        t.name,
        p.pool_address,
        p.status,
        p.real_sol_reserves,
        p.real_token_reserves,
        p.virtual_sol_reserves,
        p.virtual_token_reserves,
        p.updated_at,
        CASE 
          WHEN p.real_token_reserves > 0 AND p.real_token_reserves IS NOT NULL 
          THEN p.real_sol_reserves::numeric / p.real_token_reserves::numeric 
          ELSE NULL 
        END as price_from_reserves
      FROM pools p
      JOIN tokens t ON p.token_id = t.id
      WHERE p.real_sol_reserves IS NOT NULL
        AND p.platform = 'raydium_launchpad'
      ORDER BY p.updated_at DESC
      LIMIT 10;
    `;
    
    const result = await dbPool.query(query);
    
    console.log('\n=== POOLS WITH RESERVE DATA ===\n');
    console.log(`Found ${result.rows.length} pools with reserve data\n`);
    
    for (const row of result.rows) {
      console.log(`Token: ${row.symbol || 'Unknown'} (${row.name || 'Unnamed'})`);
      console.log(`Pool: ${row.pool_address}`);
      console.log(`Status: ${row.status}`);
      console.log(`Real SOL: ${row.real_sol_reserves}`);
      console.log(`Real Tokens: ${row.real_token_reserves}`);
      console.log(`Virtual SOL: ${row.virtual_sol_reserves}`);
      console.log(`Virtual Tokens: ${row.virtual_token_reserves}`);
      console.log(`Price: ${row.price_from_reserves ? parseFloat(row.price_from_reserves).toFixed(10) : 'N/A'} SOL per token`);
      console.log(`Updated: ${row.updated_at}`);
      console.log('\n' + '-'.repeat(60) + '\n');
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbPool.end();
  }
}

showPoolsWithReserves();