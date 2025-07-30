import * as dotenv from 'dotenv';
import { pool } from './config';
import { PoolOperations } from './pool-operations';

dotenv.config();

const poolOps = new PoolOperations(pool);

async function testPoolOperations() {
  console.log('🧪 Testing Pool Operations...\n');
  
  try {
    // First, get some existing tokens to test with
    const tokenQuery = `
      SELECT id, mint_address, symbol, platform 
      FROM tokens 
      ORDER BY created_at DESC 
      LIMIT 5
    `;
    
    const tokenResult = await pool.query(tokenQuery);
    
    if (tokenResult.rows.length === 0) {
      console.log('❌ No tokens found in database. Run a monitor first to capture some tokens.');
      return;
    }
    
    console.log('📋 Found tokens to test with:');
    tokenResult.rows.forEach(token => {
      console.log(`   - ${token.symbol || 'Unknown'} (${token.mint_address.substring(0, 10)}...) on ${token.platform}`);
    });
    
    // Test 1: Check if pools already exist for these tokens
    console.log('\n🔍 Checking existing pools...');
    for (const token of tokenResult.rows) {
      const existingPool = await poolOps.getPoolsByTokenMint(token.mint_address);
      if (existingPool.length > 0) {
        console.log(`   ✓ Pool found for ${token.symbol || token.mint_address.substring(0, 10)}: ${existingPool[0].pool_address.substring(0, 10)}...`);
      } else {
        console.log(`   ✗ No pool found for ${token.symbol || token.mint_address.substring(0, 10)}`);
      }
    }
    
    // Test 2: Query pool statistics
    console.log('\n📊 Pool Statistics:');
    const statsQuery = `
      SELECT 
        p.platform,
        COUNT(DISTINCT p.id) as pool_count,
        COUNT(DISTINCT p.token_id) as unique_tokens,
        AVG(p.initial_price)::NUMERIC(10,6) as avg_initial_price,
        MAX(p.created_at) as latest_pool
      FROM pools p
      GROUP BY p.platform
    `;
    
    const statsResult = await pool.query(statsQuery);
    
    if (statsResult.rows.length === 0) {
      console.log('   No pools in database yet.');
    } else {
      statsResult.rows.forEach(stat => {
        console.log(`\n   Platform: ${stat.platform}`);
        console.log(`   - Pool Count: ${stat.pool_count}`);
        console.log(`   - Unique Tokens: ${stat.unique_tokens}`);
        console.log(`   - Avg Initial Price: ${stat.avg_initial_price || 'N/A'}`);
        console.log(`   - Latest Pool: ${stat.latest_pool}`);
      });
    }
    
    // Test 3: Get recent pools with token info
    console.log('\n📈 Recent Pools:');
    const recentQuery = `
      SELECT 
        p.pool_address,
        p.platform,
        p.initial_price,
        p.created_at,
        t.symbol,
        t.name,
        t.mint_address
      FROM pools p
      JOIN tokens t ON p.token_id = t.id
      ORDER BY p.created_at DESC
      LIMIT 5
    `;
    
    const recentResult = await pool.query(recentQuery);
    
    if (recentResult.rows.length === 0) {
      console.log('   No pools found.');
    } else {
      recentResult.rows.forEach(pool => {
        console.log(`\n   ${pool.symbol || 'Unknown'} (${pool.platform})`);
        console.log(`   - Pool: ${pool.pool_address.substring(0, 20)}...`);
        console.log(`   - Token: ${pool.mint_address.substring(0, 20)}...`);
        console.log(`   - Initial Price: ${pool.initial_price || 'N/A'}`);
        console.log(`   - Created: ${pool.created_at}`);
      });
    }
    
    // Test 4: Check pool-token relationships
    console.log('\n🔗 Verifying Pool-Token Relationships:');
    const relationshipQuery = `
      SELECT 
        COUNT(*) as total_pools,
        COUNT(DISTINCT token_id) as unique_tokens,
        COUNT(*) FILTER (WHERE t.id IS NULL) as orphaned_pools
      FROM pools p
      LEFT JOIN tokens t ON p.token_id = t.id
    `;
    
    const relationshipResult = await pool.query(relationshipQuery);
    const rel = relationshipResult.rows[0];
    
    console.log(`   - Total Pools: ${rel.total_pools}`);
    console.log(`   - Unique Tokens with Pools: ${rel.unique_tokens}`);
    console.log(`   - Orphaned Pools: ${rel.orphaned_pools}`);
    
    if (rel.orphaned_pools > 0) {
      console.log('   ⚠️  Warning: Found orphaned pools without valid token references!');
    }
    
    console.log('\n✅ Pool operations test completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

// Run the test
testPoolOperations()
  .then(() => {
    console.log('\n🎉 All tests completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Test failed:', error);
    process.exit(1);
  });