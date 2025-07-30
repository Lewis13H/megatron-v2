import { pool } from '../config';

export async function validateTokenData() {
  console.log('🔍 Running token data validation...\n');
  
  const client = await pool.connect();
  
  try {
    // 1. Check for recent tokens
    console.log('📊 Recent tokens (last hour):');
    const recentTokens = await client.query(`
      SELECT 
        mint_address,
        symbol,
        platform,
        creation_timestamp,
        created_at
      FROM tokens 
      WHERE created_at > NOW() - INTERVAL '1 hour'
      ORDER BY created_at DESC
      LIMIT 10
    `);
    
    if (recentTokens.rows.length === 0) {
      console.log('   No tokens found in the last hour');
    } else {
      recentTokens.rows.forEach(token => {
        console.log(`   ${token.platform}: ${token.mint_address.substring(0, 10)}... ${token.symbol || 'N/A'}`);
      });
    }
    
    // 2. Check for duplicates
    console.log('\n🔍 Checking for duplicate mint addresses:');
    const duplicates = await client.query(`
      SELECT mint_address, COUNT(*) as count
      FROM tokens
      GROUP BY mint_address
      HAVING COUNT(*) > 1
    `);
    
    if (duplicates.rows.length === 0) {
      console.log('   ✅ No duplicates found');
    } else {
      console.log('   ⚠️  Found duplicates:');
      duplicates.rows.forEach(dup => {
        console.log(`      ${dup.mint_address}: ${dup.count} entries`);
      });
    }
    
    // 3. Platform distribution
    console.log('\n📊 Token distribution by platform:');
    const platformDist = await client.query(`
      SELECT 
        platform,
        COUNT(*) as total_tokens,
        COUNT(CASE WHEN is_graduated THEN 1 END) as graduated,
        MIN(creation_timestamp) as oldest,
        MAX(creation_timestamp) as newest
      FROM tokens
      GROUP BY platform
    `);
    
    platformDist.rows.forEach(platform => {
      console.log(`   ${platform.platform}:`);
      console.log(`      Total: ${platform.total_tokens}`);
      console.log(`      Graduated: ${platform.graduated}`);
      console.log(`      Date range: ${platform.oldest?.toISOString().split('T')[0]} to ${platform.newest?.toISOString().split('T')[0]}`);
    });
    
    // 4. Data completeness check
    console.log('\n📊 Data completeness:');
    const completeness = await client.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(symbol) as has_symbol,
        COUNT(name) as has_name,
        COUNT(initial_supply) as has_supply,
        COUNT(metadata) as has_metadata
      FROM tokens
    `);
    
    const stats = completeness.rows[0];
    console.log(`   Total tokens: ${stats.total}`);
    console.log(`   With symbol: ${stats.has_symbol} (${((stats.has_symbol/stats.total)*100).toFixed(1)}%)`);
    console.log(`   With name: ${stats.has_name} (${((stats.has_name/stats.total)*100).toFixed(1)}%)`);
    console.log(`   With supply: ${stats.has_supply} (${((stats.has_supply/stats.total)*100).toFixed(1)}%)`);
    console.log(`   With metadata: ${stats.has_metadata} (${((stats.has_metadata/stats.total)*100).toFixed(1)}%)`);
    
    // 5. Signature format validation
    console.log('\n🔍 Validating signature formats:');
    const invalidSigs = await client.query(`
      SELECT mint_address, creation_signature
      FROM tokens
      WHERE LENGTH(creation_signature) != 88
    `);
    
    if (invalidSigs.rows.length === 0) {
      console.log('   ✅ All signatures have correct length (88 chars)');
    } else {
      console.log(`   ⚠️  Found ${invalidSigs.rows.length} tokens with invalid signature length`);
    }
    
    // 6. Address format validation
    const invalidAddresses = await client.query(`
      SELECT COUNT(*) as count
      FROM tokens
      WHERE LENGTH(mint_address) != 44 
         OR LENGTH(creator_address) != 44
    `);
    
    if (invalidAddresses.rows[0].count === '0') {
      console.log('   ✅ All addresses have correct length (44 chars)');
    } else {
      console.log(`   ⚠️  Found ${invalidAddresses.rows[0].count} tokens with invalid address length`);
    }
    
    // 7. Time consistency check
    console.log('\n🔍 Time consistency check:');
    const timeMismatch = await client.query(`
      SELECT COUNT(*) as count
      FROM tokens
      WHERE creation_timestamp > created_at
    `);
    
    if (timeMismatch.rows[0].count === '0') {
      console.log('   ✅ All creation timestamps are consistent');
    } else {
      console.log(`   ⚠️  Found ${timeMismatch.rows[0].count} tokens with timestamp issues`);
    }
    
  } catch (error) {
    console.error('❌ Validation error:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Function to cross-reference with blockchain
export async function crossReferenceBlockchain(mintAddress: string) {
  console.log(`\n🔗 Cross-referencing token: ${mintAddress}`);
  console.log('   Instructions:');
  console.log('   1. Open Solana Explorer: https://explorer.solana.com/');
  console.log(`   2. Search for: ${mintAddress}`);
  console.log('   3. Verify:');
  console.log('      - Token exists on chain');
  console.log('      - Creation transaction matches our signature');
  console.log('      - Creator address matches');
  console.log('      - Decimals match (usually 6 for memecoins)');
  
  // Query our data for comparison
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        mint_address,
        creation_signature,
        creator_address,
        decimals,
        platform,
        creation_timestamp
      FROM tokens
      WHERE mint_address = $1
    `, [mintAddress]);
    
    if (result.rows.length > 0) {
      const token = result.rows[0];
      console.log('\n   Our data:');
      console.log(`      Signature: ${token.creation_signature}`);
      console.log(`      Creator: ${token.creator_address}`);
      console.log(`      Decimals: ${token.decimals}`);
      console.log(`      Platform: ${token.platform}`);
      console.log(`      Timestamp: ${token.creation_timestamp}`);
    }
  } finally {
    client.release();
  }
}

// Run validation if called directly
if (require.main === module) {
  validateTokenData()
    .then(() => {
      // Example: cross-reference a specific token
      // return crossReferenceBlockchain('YOUR_TOKEN_MINT_ADDRESS');
    })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}