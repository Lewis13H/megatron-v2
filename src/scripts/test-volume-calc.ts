import { getDbPool } from '../database/connection';

async function testVolumeCalculation() {
  const pool = getDbPool();
  
  try {
    console.log('Testing volume calculations...\n');
    
    // Get SOL price
    const solPriceResult = await pool.query(`
      SELECT price_usd 
      FROM sol_usd_prices 
      ORDER BY price_time DESC 
      LIMIT 1
    `);
    const solPrice = solPriceResult.rows[0]?.price_usd || 200;
    console.log(`Current SOL price: $${solPrice}\n`);
    
    // Test volume calculation for tokens with transactions
    const volumeResult = await pool.query(`
      SELECT 
        t.symbol,
        t.mint_address,
        COUNT(tx.signature) as txn_count,
        COALESCE(SUM(tx.sol_amount), 0) as volume_24h_sol,
        COALESCE(SUM(CASE WHEN tx.type = 'buy' THEN tx.sol_amount ELSE 0 END), 0) as buy_volume_sol,
        COALESCE(SUM(CASE WHEN tx.type = 'sell' THEN tx.sol_amount ELSE 0 END), 0) as sell_volume_sol
      FROM tokens t
      LEFT JOIN transactions tx ON t.id = tx.token_id 
        AND tx.block_time > NOW() - INTERVAL '24 hours'
        AND tx.type IN ('buy', 'sell')
      GROUP BY t.id, t.symbol, t.mint_address
      HAVING COUNT(tx.signature) > 0
      ORDER BY COALESCE(SUM(tx.sol_amount), 0) DESC
      LIMIT 10
    `);
    
    console.log('Top 10 tokens by 24h volume:');
    console.log('Symbol | Address | Transactions | Volume (SOL) | Volume (USD) | Buy/Sell');
    console.log('-'.repeat(90));
    
    volumeResult.rows.forEach(row => {
      const volumeSol = parseFloat(row.volume_24h_sol);
      const volumeUsd = volumeSol * solPrice;
      const buyVolume = parseFloat(row.buy_volume_sol);
      const sellVolume = parseFloat(row.sell_volume_sol);
      
      console.log(
        `${row.symbol.padEnd(6)} | ${row.mint_address.substring(0, 8)}... | ${
          row.txn_count.toString().padStart(12)
        } | ${volumeSol.toFixed(4).padStart(12)} | $${
          volumeUsd.toFixed(2).padStart(11)
        } | ${buyVolume.toFixed(2)}/${sellVolume.toFixed(2)}`
      );
    });
    
    // Test the actual query used in the API
    console.log('\n\nTesting API query performance...');
    const startTime = Date.now();
    
    const apiQuery = await pool.query(`
      SELECT 
        t.mint_address,
        t.symbol,
        (SELECT COUNT(*) FROM transactions WHERE token_id = t.id AND block_time > NOW() - INTERVAL '24 hours') as txns_24h,
        (SELECT COALESCE(SUM(sol_amount), 0) FROM transactions WHERE token_id = t.id AND block_time > NOW() - INTERVAL '24 hours' AND type IN ('buy', 'sell')) as volume_24h_sol
      FROM tokens t
      WHERE t.created_at > NOW() - INTERVAL '30 days'
      LIMIT 50
    `);
    
    const queryTime = Date.now() - startTime;
    console.log(`Query executed in ${queryTime}ms for ${apiQuery.rows.length} tokens`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

testVolumeCalculation();