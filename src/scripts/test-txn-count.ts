import { getDbPool } from '../database/connection';

async function testTransactionCount() {
  const pool = getDbPool();
  
  try {
    // Test the basic count
    console.log('Testing transaction counts...');
    
    const totalResult = await pool.query('SELECT COUNT(*) as count FROM transactions');
    console.log('Total transactions in database:', totalResult.rows[0].count);
    
    const last24hResult = await pool.query(`
      SELECT COUNT(*) as count 
      FROM transactions 
      WHERE block_time > NOW() - INTERVAL '24 hours'
    `);
    console.log('Transactions in last 24 hours:', last24hResult.rows[0].count);
    
    // Test with a specific token if we have any
    const tokenResult = await pool.query(`
      SELECT t.symbol, t.mint_address,
        (SELECT COUNT(*) FROM transactions WHERE token_id = t.id) as total_txns,
        (SELECT COUNT(*) FROM transactions WHERE token_id = t.id AND block_time > NOW() - INTERVAL '24 hours') as txns_24h
      FROM tokens t
      LIMIT 5
    `);
    
    console.log('\nTransaction counts for first 5 tokens:');
    tokenResult.rows.forEach(row => {
      console.log(`${row.symbol} (${row.mint_address.substring(0, 8)}...): ${row.total_txns} total, ${row.txns_24h} in 24h`);
    });
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

testTransactionCount();