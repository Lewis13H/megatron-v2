import { getDbPool } from './connection';

async function showPoolsWithActivity() {
  const dbPool = getDbPool();
  
  try {
    const query = `
      WITH pool_activity AS (
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
          p.updated_at as pool_updated,
          CASE 
            WHEN p.real_token_reserves > 0 AND p.real_token_reserves IS NOT NULL 
            THEN (p.real_sol_reserves::numeric / 1e9) / (p.real_token_reserves::numeric / 1e6) 
            ELSE NULL 
          END as price_from_reserves,
          COUNT(tx.signature) as transaction_count,
          SUM(CASE WHEN tx.type = 'buy' THEN 1 ELSE 0 END) as buy_count,
          SUM(CASE WHEN tx.type = 'sell' THEN 1 ELSE 0 END) as sell_count,
          SUM(CASE WHEN tx.type = 'buy' THEN tx.sol_amount ELSE 0 END) as buy_volume,
          SUM(CASE WHEN tx.type = 'sell' THEN tx.sol_amount ELSE 0 END) as sell_volume,
          MAX(tx.block_time) as last_transaction
        FROM pools p
        JOIN tokens t ON p.token_id = t.id
        LEFT JOIN transactions tx ON t.id = tx.token_id
        WHERE p.platform = 'raydium_launchpad'
          AND p.real_sol_reserves IS NOT NULL
        GROUP BY t.mint_address, t.symbol, t.name, p.pool_address, p.status, 
                 p.real_sol_reserves, p.real_token_reserves, p.virtual_sol_reserves, 
                 p.virtual_token_reserves, p.updated_at
        HAVING COUNT(tx.signature) > 0
      )
      SELECT * FROM pool_activity
      ORDER BY transaction_count DESC
      LIMIT 10;
    `;
    
    const result = await dbPool.query(query);
    
    console.log('\n=== POOLS WITH RESERVES AND TRANSACTION ACTIVITY ===\n');
    console.log(`Found ${result.rows.length} active pools\n`);
    
    for (const row of result.rows) {
      console.log(`Token: ${row.symbol || 'Unknown'} (${row.name || 'Unnamed'})`);
      console.log(`Mint: ${row.mint_address}`);
      console.log(`Pool: ${row.pool_address}`);
      console.log(`Status: ${row.status}`);
      console.log(`\nReserves:`);
      console.log(`  Real SOL: ${(parseInt(row.real_sol_reserves) / 1e9).toFixed(4)} SOL`);
      console.log(`  Real Tokens: ${(parseInt(row.real_token_reserves) / 1e6).toFixed(2)} tokens`);
      console.log(`  Price from reserves: ${row.price_from_reserves ? parseFloat(row.price_from_reserves).toFixed(10) : 'N/A'} SOL per token`);
      console.log(`\nActivity:`);
      console.log(`  Total transactions: ${row.transaction_count}`);
      console.log(`  Buys: ${row.buy_count} (${row.buy_volume ? parseFloat(row.buy_volume).toFixed(4) : '0'} SOL)`);
      console.log(`  Sells: ${row.sell_count} (${row.sell_volume ? parseFloat(row.sell_volume).toFixed(4) : '0'} SOL)`);
      console.log(`  Last transaction: ${row.last_transaction || 'N/A'}`);
      console.log(`  Pool last updated: ${row.pool_updated}`);
      console.log('\n' + '='.repeat(70) + '\n');
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbPool.end();
  }
}

showPoolsWithActivity();