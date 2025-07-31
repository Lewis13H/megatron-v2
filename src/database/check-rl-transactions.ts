import { getDbPool } from './connection';

async function checkRaydiumLaunchpadTransactions() {
  const pool = getDbPool();
  
  try {
    // Check total transactions from Raydium Launchpad
    const totalQuery = `
      SELECT 
        COUNT(*) as total_transactions,
        COUNT(DISTINCT token_id) as unique_tokens,
        COUNT(DISTINCT pool_id) as unique_pools,
        COUNT(CASE WHEN type = 'buy' THEN 1 END) as buy_count,
        COUNT(CASE WHEN type = 'sell' THEN 1 END) as sell_count,
        MIN(block_time) as first_transaction,
        MAX(block_time) as last_transaction
      FROM transactions 
      WHERE raw_data->>'program' = 'raydium_launchpad'
    `;
    
    const result = await pool.query(totalQuery);
    const stats = result.rows[0];
    
    console.log('=== Raydium Launchpad Transaction Statistics ===');
    console.log(`Total Transactions: ${stats.total_transactions}`);
    console.log(`Unique Tokens: ${stats.unique_tokens}`);
    console.log(`Unique Pools: ${stats.unique_pools}`);
    console.log(`Buy Transactions: ${stats.buy_count}`);
    console.log(`Sell Transactions: ${stats.sell_count}`);
    console.log(`First Transaction: ${stats.first_transaction || 'None'}`);
    console.log(`Last Transaction: ${stats.last_transaction || 'None'}`);
    
    // If there are transactions, show some recent ones
    if (parseInt(stats.total_transactions) > 0) {
      console.log('\n=== Recent Transactions (Last 5) ===');
      const recentQuery = `
        SELECT 
          t.signature,
          t.type,
          t.token_id,
          tok.mint_address,
          t.sol_amount,
          t.token_amount,
          t.block_time
        FROM transactions t
        LEFT JOIN tokens tok ON tok.id = t.token_id
        WHERE t.raw_data->>'program' = 'raydium_launchpad'
        ORDER BY t.block_time DESC
        LIMIT 5
      `;
      
      const recentResult = await pool.query(recentQuery);
      recentResult.rows.forEach((tx, i) => {
        console.log(`\n${i + 1}. ${tx.type.toUpperCase()} - ${new Date(tx.block_time).toISOString()}`);
        console.log(`   Signature: ${tx.signature.substring(0, 20)}...`);
        console.log(`   Token: ${tx.mint_address || 'Unknown'}`);
        console.log(`   SOL Amount: ${tx.sol_amount}`);
        console.log(`   Token Amount: ${tx.token_amount}`);
      });
    }
    
  } catch (error) {
    console.error('Error checking transactions:', error);
  } finally {
    await pool.end();
  }
}

// Run the check
checkRaydiumLaunchpadTransactions();