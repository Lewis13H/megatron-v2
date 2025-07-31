import { getDbPool } from './connection';

async function calculateMarketCap() {
  const dbPool = getDbPool();
  
  try {
    const query = `
      WITH pool_data AS (
        SELECT 
          t.mint_address,
          t.symbol,
          t.name,
          p.pool_address,
          p.real_sol_reserves / 1e9 as real_sol,
          p.real_token_reserves / 1e6 as real_tokens,
          p.virtual_sol_reserves / 1e9 as virtual_sol,
          p.virtual_token_reserves / 1e6 as virtual_tokens,
          -- Price calculation using real reserves
          CASE 
            WHEN p.real_token_reserves > 0 
            THEN (p.real_sol_reserves::numeric / 1e9) / (p.real_token_reserves::numeric / 1e6)
            ELSE NULL 
          END as price_per_token
        FROM pools p
        JOIN tokens t ON p.token_id = t.id
        WHERE p.platform = 'raydium_launchpad'
          AND p.real_sol_reserves IS NOT NULL
      )
      SELECT 
        mint_address,
        symbol,
        name,
        pool_address,
        real_sol,
        real_tokens,
        price_per_token,
        -- Standard token supply is 1 billion
        1000000000 as total_supply,
        -- Market cap calculation
        price_per_token * 1000000000 as market_cap_sol,
        -- FDV (Fully Diluted Valuation) is the same since all tokens exist
        price_per_token * 1000000000 as fdv_sol
      FROM pool_data
      WHERE price_per_token IS NOT NULL
      ORDER BY market_cap_sol DESC
      LIMIT 20;
    `;
    
    const result = await dbPool.query(query);
    
    console.log('\n=== MARKET CAP ANALYSIS (RAYDIUM LAUNCHLAB) ===');
    console.log('Total Supply: 1,000,000,000 tokens (1 billion)\n');
    
    for (const row of result.rows) {
      console.log(`Token: ${row.symbol || row.mint_address.slice(0,8)}...`);
      console.log(`Pool: ${row.pool_address}`);
      console.log(`Price: ${parseFloat(row.price_per_token).toFixed(10)} SOL per token`);
      console.log(`Market Cap: ${parseFloat(row.market_cap_sol).toFixed(2)} SOL`);
      console.log(`Real SOL in pool: ${parseFloat(row.real_sol).toFixed(2)} SOL`);
      console.log(`Real tokens in pool: ${parseFloat(row.real_tokens).toFixed(2)} tokens`);
      console.log(`% of supply in pool: ${(parseFloat(row.real_tokens) / parseFloat(row.total_supply) * 100).toFixed(2)}%\n`);
    }
    
    // Summary statistics
    const statsQuery = `
      SELECT 
        AVG(price_per_token * 1000000000) as avg_market_cap,
        MIN(price_per_token * 1000000000) as min_market_cap,
        MAX(price_per_token * 1000000000) as max_market_cap
      FROM (
        SELECT 
          CASE 
            WHEN p.real_token_reserves > 0 
            THEN (p.real_sol_reserves::numeric / 1e9) / (p.real_token_reserves::numeric / 1e6)
            ELSE NULL 
          END as price_per_token
        FROM pools p
        WHERE p.platform = 'raydium_launchpad'
          AND p.real_sol_reserves IS NOT NULL
      ) prices
      WHERE price_per_token IS NOT NULL;
    `;
    
    const stats = await dbPool.query(statsQuery);
    console.log('=== MARKET CAP STATISTICS ===');
    console.log(`Average Market Cap: ${parseFloat(stats.rows[0].avg_market_cap).toFixed(2)} SOL`);
    console.log(`Min Market Cap: ${parseFloat(stats.rows[0].min_market_cap).toFixed(2)} SOL`);
    console.log(`Max Market Cap: ${parseFloat(stats.rows[0].max_market_cap).toFixed(2)} SOL`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbPool.end();
  }
}

calculateMarketCap();