import { TransactionOperations, Transaction } from './transaction-operations';
import { getDbPool } from './connection';

// Test data generators
function generateTestTransaction(
  poolId: string,
  tokenId: string,
  index: number
): Transaction {
  const types: ('buy' | 'sell')[] = ['buy', 'sell'];
  const type = types[Math.floor(Math.random() * types.length)];
  const solAmount = Math.random() * 10; // 0-10 SOL
  const tokenAmount = solAmount * (100000 + Math.random() * 900000); // Random price
  
  return {
    signature: `test_sig_${Date.now()}_${index}_${Math.random().toString(36).substring(7)}`,
    pool_id: poolId,
    token_id: tokenId,
    block_time: new Date(Date.now() - Math.random() * 3600000), // Random time in last hour
    slot: 250000000 + index,
    type: type,
    user_address: `user_${Math.floor(Math.random() * 1000)}`,
    amount_in: type === 'buy' ? (solAmount * 1e9).toString() : (tokenAmount * 1e6).toString(),
    amount_in_decimals: type === 'buy' ? 9 : 6,
    amount_out: type === 'buy' ? (tokenAmount * 1e6).toString() : (solAmount * 1e9).toString(),
    amount_out_decimals: type === 'buy' ? 6 : 9,
    sol_amount: solAmount,
    token_amount: tokenAmount,
    price_per_token: solAmount / tokenAmount,
    transaction_fee: 5000,
    success: true,
    raw_data: { test: true, index: index }
  };
}

async function testSingleInsertion() {
  console.log('\\n=== Testing Single Transaction Insertion ===');
  const ops = new TransactionOperations();
  
  // First, we need a test token and pool
  const pool = getDbPool();
  
  try {
    // Create test token
    const tokenResult = await pool.query(`
      INSERT INTO tokens (
        mint_address, symbol, name, decimals, platform,
        creation_signature, creation_timestamp, creator_address
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      )
      ON CONFLICT (mint_address) DO UPDATE SET updated_at = NOW()
      RETURNING id
    `, [
      `test_mint_${Date.now()}`,
      'TEST',
      'Test Token',
      6,
      'pumpfun',
      'test_creation_sig',
      new Date(),
      'test_creator'
    ]);
    
    const tokenId = tokenResult.rows[0].id;
    
    // Create test pool
    const poolResult = await pool.query(`
      INSERT INTO pools (
        pool_address, token_id, base_mint, quote_mint, platform
      ) VALUES (
        $1, $2, $3, $4, $5
      )
      ON CONFLICT (pool_address) DO UPDATE SET updated_at = NOW()
      RETURNING id
    `, [
      `test_pool_${Date.now()}`,
      tokenId,
      `test_mint_${Date.now()}`,
      'So11111111111111111111111111111111111111112', // WSOL
      'pumpfun'
    ]);
    
    const poolId = poolResult.rows[0].id;
    
    // Test single insertion
    const testTx = generateTestTransaction(poolId, tokenId, 1);
    const startTime = Date.now();
    
    await ops.insertTransaction(testTx);
    
    const duration = Date.now() - startTime;
    console.log(`✅ Single transaction inserted in ${duration}ms`);
    
    // Verify insertion
    const verifyResult = await pool.query(
      'SELECT * FROM transactions WHERE signature = $1',
      [testTx.signature]
    );
    
    if (verifyResult.rows.length > 0) {
      console.log('✅ Transaction verified in database');
      console.log(`   Price per token: ${verifyResult.rows[0].price_per_token}`);
    } else {
      console.log('❌ Transaction not found in database');
    }
    
    return { tokenId, poolId };
  } catch (error) {
    console.error('❌ Error in single insertion test:', error);
    throw error;
  }
}

async function testBulkInsertion(poolId: string, tokenId: string) {
  console.log('\\n=== Testing Bulk Transaction Insertion ===');
  const ops = new TransactionOperations();
  
  // Generate test transactions
  const batchSizes = [100, 1000, 5000];
  
  for (const batchSize of batchSizes) {
    console.log(`\\nTesting batch size: ${batchSize}`);
    
    const transactions: Transaction[] = [];
    for (let i = 0; i < batchSize; i++) {
      transactions.push(generateTestTransaction(poolId, tokenId, i));
    }
    
    const startTime = Date.now();
    const inserted = await ops.bulkInsertTransactions(transactions);
    const duration = Date.now() - startTime;
    
    const txPerSecond = (batchSize / (duration / 1000)).toFixed(2);
    console.log(`✅ Inserted ${inserted} transactions in ${duration}ms`);
    console.log(`   Rate: ${txPerSecond} transactions/second`);
  }
}

async function testQueryPerformance(tokenId: string) {
  console.log('\\n=== Testing Query Performance ===');
  const ops = new TransactionOperations();
  const pool = getDbPool();
  
  // Test recent transactions query
  console.log('\\n1. Testing recent transactions query:');
  let startTime = Date.now();
  const recentTxs = await ops.getRecentTransactions(tokenId, 100);
  let duration = Date.now() - startTime;
  console.log(`   ✅ Retrieved ${recentTxs.length} transactions in ${duration}ms`);
  
  // Test volume statistics
  console.log('\\n2. Testing volume statistics:');
  startTime = Date.now();
  const volumeStats = await ops.getVolumeStats(tokenId, 1);
  duration = Date.now() - startTime;
  console.log(`   ✅ Volume stats calculated in ${duration}ms`);
  console.log(`   Total volume: ${volumeStats.total_volume_sol} SOL`);
  console.log(`   Transaction count: ${volumeStats.transaction_count}`);
  console.log(`   Unique traders: ${volumeStats.unique_traders}`);
  
  // Test transaction count by type
  console.log('\\n3. Testing transaction count by type:');
  startTime = Date.now();
  const txByType = await ops.getTransactionCountByType(tokenId, 1);
  duration = Date.now() - startTime;
  console.log(`   ✅ Type breakdown calculated in ${duration}ms`);
  txByType.forEach(row => {
    console.log(`   ${row.type}: ${row.count} transactions, ${row.total_sol_volume} SOL`);
  });
  
  // Test direct time-range query
  console.log('\\n4. Testing time-range query performance:');
  const query = `
    SELECT COUNT(*), MIN(block_time), MAX(block_time)
    FROM transactions
    WHERE token_id = $1
      AND block_time > NOW() - INTERVAL '1 hour'
  `;
  
  startTime = Date.now();
  const result = await pool.query(query, [tokenId]);
  duration = Date.now() - startTime;
  console.log(`   ✅ Time-range query completed in ${duration}ms`);
  console.log(`   Found ${result.rows[0].count} transactions`);
}

async function testHypertableInfo() {
  console.log('\\n=== Testing Hypertable Information ===');
  const ops = new TransactionOperations();
  
  const hypertableInfo = await ops.getHypertableInfo();
  console.log('\\nHypertable Info:');
  console.log(`  Name: ${hypertableInfo.hypertable_name}`);
  console.log(`  Chunks: ${hypertableInfo.num_chunks}`);
  console.log(`  Total Size: ${hypertableInfo.total_size}`);
  console.log(`  Compression Enabled: ${hypertableInfo.compression_enabled}`);
  
  const chunkStats = await ops.getChunkStats();
  console.log('\\nRecent Chunks:');
  chunkStats.forEach(chunk => {
    console.log(`  ${chunk.chunk_name}: ${chunk.chunk_size} (${chunk.is_compressed ? 'compressed' : 'uncompressed'})`);
  });
}

async function validateDataIntegrity(tokenId: string) {
  console.log('\\n=== Validating Data Integrity ===');
  const pool = getDbPool();
  
  // Check for duplicate signatures
  const dupQuery = `
    SELECT signature, COUNT(*) as count
    FROM transactions
    WHERE token_id = $1
    GROUP BY signature
    HAVING COUNT(*) > 1
  `;
  
  const dupResult = await pool.query(dupQuery, [tokenId]);
  if (dupResult.rows.length === 0) {
    console.log('✅ No duplicate signatures found');
  } else {
    console.log(`❌ Found ${dupResult.rows.length} duplicate signatures`);
  }
  
  // Verify calculated fields
  const calcQuery = `
    SELECT COUNT(*) as incorrect_calculations
    FROM transactions
    WHERE token_id = $1
      AND ABS(price_per_token - (sol_amount / NULLIF(token_amount, 0))) > 0.0000001
      AND token_amount > 0
  `;
  
  const calcResult = await pool.query(calcQuery, [tokenId]);
  if (calcResult.rows[0].incorrect_calculations === '0') {
    console.log('✅ All price calculations are correct');
  } else {
    console.log(`❌ Found ${calcResult.rows[0].incorrect_calculations} incorrect price calculations`);
  }
  
  // Check time ordering
  const timeQuery = `
    WITH ordered_txs AS (
      SELECT 
        signature,
        block_time,
        slot,
        LAG(slot) OVER (ORDER BY block_time) as prev_slot
      FROM transactions
      WHERE token_id = $1
    )
    SELECT COUNT(*) as out_of_order
    FROM ordered_txs
    WHERE prev_slot IS NOT NULL AND slot < prev_slot
  `;
  
  const timeResult = await pool.query(timeQuery, [tokenId]);
  if (timeResult.rows[0].out_of_order === '0') {
    console.log('✅ All transactions are properly time-ordered');
  } else {
    console.log(`❌ Found ${timeResult.rows[0].out_of_order} out-of-order transactions`);
  }
}

// Main test runner
async function runAllTests() {
  console.log('Starting Transaction Operations Tests...');
  
  try {
    // Test single insertion and get test IDs
    const { tokenId, poolId } = await testSingleInsertion();
    
    // Test bulk insertion
    await testBulkInsertion(poolId, tokenId);
    
    // Test query performance
    await testQueryPerformance(tokenId);
    
    // Test hypertable info
    await testHypertableInfo();
    
    // Validate data integrity
    await validateDataIntegrity(tokenId);
    
    console.log('\\n✅ All tests completed successfully!');
  } catch (error) {
    console.error('\\n❌ Test failed:', error);
  } finally {
    // Close the connection pool
    const pool = getDbPool();
    await pool.end();
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests();
}