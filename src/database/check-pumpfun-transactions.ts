import { Pool } from 'pg';
import { getDbPool } from './connection';
import 'dotenv/config';

async function checkPumpfunTransactions() {
  const pool = getDbPool();
  
  try {
    console.log('Checking Pump.fun transactions in database...\n');

    // 1. Check total count
    const countResult = await pool.query(`
      SELECT 
        COUNT(*) as total_pumpfun_transactions,
        MIN(block_time) as earliest_transaction,
        MAX(block_time) as latest_transaction
      FROM transactions t
      JOIN pools p ON t.pool_id = p.id
      WHERE p.platform = 'pumpfun'
    `);

    const stats = countResult.rows[0];
    console.log('📊 Transaction Statistics:');
    console.log(`Total Pump.fun transactions: ${stats.total_pumpfun_transactions}`);
    console.log(`Earliest transaction: ${stats.earliest_transaction || 'None'}`);
    console.log(`Latest transaction: ${stats.latest_transaction || 'None'}`);
    console.log('');

    if (parseInt(stats.total_pumpfun_transactions) === 0) {
      console.log('❌ No Pump.fun transactions found in database!');
      console.log('\nPossible reasons:');
      console.log('1. The monitor hasn\'t detected any transactions yet');
      console.log('2. Tokens/pools haven\'t been saved to the database first');
      console.log('3. There\'s an issue with the database connection');
      
      // Check if there are any pumpfun tokens/pools
      const tokenCheck = await pool.query(`
        SELECT 
          COUNT(DISTINCT tok.id) as token_count,
          COUNT(DISTINCT p.id) as pool_count
        FROM tokens tok
        LEFT JOIN pools p ON tok.id = p.token_id
        WHERE tok.platform = 'pumpfun' OR p.platform = 'pumpfun'
      `);
      
      const tokenStats = tokenCheck.rows[0];
      console.log(`\n📝 Pump.fun tokens in database: ${tokenStats.token_count}`);
      console.log(`📝 Pump.fun pools in database: ${tokenStats.pool_count}`);
      
      if (parseInt(tokenStats.token_count) === 0) {
        console.log('\n⚠️  No Pump.fun tokens found! Make sure to run the token creation monitor first.');
      }
      
      return;
    }

    // 2. Show recent transactions
    const recentTxResult = await pool.query(`
      SELECT 
        t.signature,
        t.type,
        t.user_address,
        t.sol_amount,
        t.token_amount,
        t.price_per_token,
        t.block_time,
        tok.symbol,
        tok.name,
        tok.mint_address
      FROM transactions t
      JOIN pools p ON t.pool_id = p.id
      JOIN tokens tok ON t.token_id = tok.id
      WHERE p.platform = 'pumpfun'
      ORDER BY t.block_time DESC
      LIMIT 5
    `);

    console.log('📜 Recent Transactions:');
    recentTxResult.rows.forEach((tx, index) => {
      console.log(`\n${index + 1}. ${tx.type.toUpperCase()} - ${tx.symbol || 'Unknown'} (${tx.name || 'Unknown'})`);
      console.log(`   Signature: ${tx.signature}`);
      console.log(`   User: ${tx.user_address}`);
      console.log(`   Amount: ${tx.sol_amount} SOL ↔ ${tx.token_amount} tokens`);
      console.log(`   Price: ${tx.price_per_token} SOL per token`);
      console.log(`   Time: ${tx.block_time}`);
    });

    // 3. Transaction type distribution
    const typeResult = await pool.query(`
      SELECT 
        t.type,
        COUNT(*) as count,
        SUM(t.sol_amount) as total_sol_volume,
        AVG(t.sol_amount) as avg_sol_per_tx
      FROM transactions t
      JOIN pools p ON t.pool_id = p.id
      WHERE p.platform = 'pumpfun'
      GROUP BY t.type
      ORDER BY count DESC
    `);

    console.log('\n📈 Transaction Type Distribution:');
    typeResult.rows.forEach(row => {
      console.log(`${row.type}: ${row.count} transactions, ${parseFloat(row.total_sol_volume).toFixed(2)} SOL total volume`);
    });

    // 4. Top traded tokens
    const topTokensResult = await pool.query(`
      SELECT 
        tok.symbol,
        tok.name,
        tok.mint_address,
        COUNT(t.signature) as tx_count,
        SUM(CASE WHEN t.type = 'buy' THEN 1 ELSE 0 END) as buy_count,
        SUM(CASE WHEN t.type = 'sell' THEN 1 ELSE 0 END) as sell_count,
        SUM(t.sol_amount) as total_sol_volume
      FROM transactions t
      JOIN pools p ON t.pool_id = p.id
      JOIN tokens tok ON t.token_id = tok.id
      WHERE p.platform = 'pumpfun'
      GROUP BY tok.symbol, tok.name, tok.mint_address
      ORDER BY tx_count DESC
      LIMIT 5
    `);

    if (topTokensResult.rows.length > 0) {
      console.log('\n🏆 Top 5 Most Traded Tokens:');
      topTokensResult.rows.forEach((token, index) => {
        console.log(`\n${index + 1}. ${token.symbol || 'Unknown'} (${token.name || 'Unknown'})`);
        console.log(`   Mint: ${token.mint_address}`);
        console.log(`   Transactions: ${token.tx_count} (${token.buy_count} buys, ${token.sell_count} sells)`);
        console.log(`   Volume: ${parseFloat(token.total_sol_volume).toFixed(2)} SOL`);
      });
    }

    console.log('\n✅ Database check complete!');

  } catch (error) {
    console.error('Error checking database:', error);
  } finally {
    await pool.end();
  }
}

// Run the check
checkPumpfunTransactions();