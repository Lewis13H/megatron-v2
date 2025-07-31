import { getDbPool } from './connection';

async function checkTransactionAmounts() {
  const dbPool = getDbPool();
  
  try {
    // First check if we have any non-zero SOL amounts
    const countQuery = `
      SELECT 
        COUNT(*) as total_transactions,
        COUNT(CASE WHEN sol_amount > 0 THEN 1 END) as with_sol_amount,
        COUNT(CASE WHEN sol_amount = 0 THEN 1 END) as zero_sol_amount
      FROM transactions;
    `;
    
    const countResult = await dbPool.query(countQuery);
    console.log('\n=== TRANSACTION SOL AMOUNT SUMMARY ===');
    console.log(`Total transactions: ${countResult.rows[0].total_transactions}`);
    console.log(`With SOL amount > 0: ${countResult.rows[0].with_sol_amount}`);
    console.log(`With SOL amount = 0: ${countResult.rows[0].zero_sol_amount}`);
    
    // Now check some specific transactions
    const query = `
      SELECT 
        t.symbol,
        t.mint_address,
        tx.signature,
        tx.type,
        tx.sol_amount,
        tx.token_amount,
        tx.price_per_token,
        tx.block_time,
        tx.user_address
      FROM transactions tx
      JOIN tokens t ON tx.token_id = t.id
      ORDER BY tx.block_time DESC
      LIMIT 10;
    `;
    
    const result = await dbPool.query(query);
    
    console.log('\n=== RECENT TRANSACTIONS ===\n');
    
    for (const row of result.rows) {
      console.log(`Token: ${row.symbol || row.mint_address.slice(0,8)}...`);
      console.log(`Type: ${row.type}`);
      console.log(`SOL amount (raw): ${row.sol_amount}`);
      console.log(`SOL amount: ${row.sol_amount ? (parseInt(row.sol_amount) / 1e9).toFixed(6) : '0'} SOL`);
      console.log(`Token amount (raw): ${row.token_amount}`);
      console.log(`Token amount: ${row.token_amount ? (parseInt(row.token_amount) / 1e6).toFixed(2) : '0'} tokens`);
      console.log(`Price: ${row.price_per_token || 'null'}`);
      console.log(`User: ${row.user_address}`);
      console.log(`Time: ${row.block_time}`);
      console.log(`Sig: ${row.signature.slice(0,30)}...\n`);
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbPool.end();
  }
}

checkTransactionAmounts();