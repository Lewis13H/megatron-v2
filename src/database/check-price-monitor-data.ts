import { getDbPool } from './connection';

async function checkPriceMonitorData() {
  const pool = getDbPool();
  
  try {
    // Check recent pool updates
    console.log('=== Recent Pool Updates ===');
    const poolsQuery = `
      SELECT 
        p.pool_address,
        p.bonding_curve_address,
        p.base_mint,
        p.virtual_sol_reserves,
        p.virtual_token_reserves,
        p.real_sol_reserves,
        p.real_token_reserves,
        p.latest_price,
        p.updated_at
      FROM pools p
      WHERE p.platform = 'pumpfun'
        AND p.updated_at > NOW() - INTERVAL '10 minutes'
      ORDER BY p.updated_at DESC
      LIMIT 5
    `;
    
    const poolsResult = await pool.query(poolsQuery);
    console.log('Recent pool updates:');
    poolsResult.rows.forEach(row => {
      console.log({
        mint: row.base_mint.substring(0, 10) + '...',
        bonding_curve: row.bonding_curve_address?.substring(0, 10) + '...',
        virtual_sol_reserves: row.virtual_sol_reserves,
        virtual_token_reserves: row.virtual_token_reserves,
        real_sol_reserves: row.real_sol_reserves,
        real_token_reserves: row.real_token_reserves,
        latest_price: row.latest_price,
        updated_at: row.updated_at
      });
    });
    
    // Check recent transactions
    console.log('\n=== Recent Transactions ===');
    const txQuery = `
      SELECT 
        t.signature,
        t.type,
        t.sol_amount,
        t.token_amount,
        t.price_per_token,
        t.block_time,
        tok.mint_address,
        tok.symbol
      FROM transactions t
      JOIN tokens tok ON t.token_id = tok.id
      WHERE tok.platform = 'pumpfun'
        AND t.block_time > NOW() - INTERVAL '10 minutes'
      ORDER BY t.block_time DESC
      LIMIT 5
    `;
    
    const txResult = await pool.query(txQuery);
    console.log('Recent transactions:');
    txResult.rows.forEach(row => {
      console.log({
        signature: row.signature.substring(0, 10) + '...',
        type: row.type,
        sol_amount: row.sol_amount,
        token_amount: row.token_amount,
        price_per_token: row.price_per_token,
        mint: row.mint_address.substring(0, 10) + '...',
        symbol: row.symbol
      });
    });
    
  } catch (error) {
    console.error('Error checking data:', error);
  } finally {
    await pool.end();
  }
}

checkPriceMonitorData();