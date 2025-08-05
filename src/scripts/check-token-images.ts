import { getDbPool } from '../database/connection';

async function checkTokenImages() {
  const pool = getDbPool();
  
  try {
    // Check tokens with metadata
    const result = await pool.query(`
      SELECT 
        mint_address,
        symbol,
        name,
        metadata,
        metadata->>'image' as direct_image,
        metadata->'offChainMetadata'->>'image' as offchain_image,
        metadata->>'uri' as metadata_uri
      FROM tokens
      WHERE metadata IS NOT NULL
      LIMIT 10
    `);
    
    console.log('Token Image Analysis:');
    console.log('====================\n');
    
    result.rows.forEach((row, index) => {
      console.log(`Token ${index + 1}: ${row.symbol} (${row.mint_address.substring(0, 8)}...)`);
      console.log(`  Direct image: ${row.direct_image || 'Not found'}`);
      console.log(`  Off-chain image: ${row.offchain_image || 'Not found'}`);
      console.log(`  Metadata URI: ${row.metadata_uri || 'Not found'}`);
      console.log(`  Has metadata: ${row.metadata ? 'Yes' : 'No'}`);
      if (row.metadata && row.metadata.offChainMetadata) {
        console.log(`  Off-chain metadata keys: ${Object.keys(row.metadata.offChainMetadata).join(', ')}`);
      }
      console.log('');
    });
    
    // Count tokens with images
    const imageCount = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE metadata->>'image' IS NOT NULL) as direct_image_count,
        COUNT(*) FILTER (WHERE metadata->'offChainMetadata'->>'image' IS NOT NULL) as offchain_image_count,
        COUNT(*) as total_tokens
      FROM tokens
    `);
    
    console.log('\nImage Statistics:');
    console.log(`Total tokens: ${imageCount.rows[0].total_tokens}`);
    console.log(`Tokens with direct image: ${imageCount.rows[0].direct_image_count}`);
    console.log(`Tokens with off-chain image: ${imageCount.rows[0].offchain_image_count}`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

checkTokenImages();