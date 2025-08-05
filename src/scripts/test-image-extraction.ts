import { getDbPool } from '../database/connection';

async function testImageExtraction() {
  const pool = getDbPool();
  
  try {
    const result = await pool.query(`
      SELECT 
        t.mint_address,
        t.symbol,
        t.name,
        COALESCE(
          t.metadata->'offChainMetadata'->>'image',
          t.metadata->>'image',
          t.metadata->>'imageUri',
          t.metadata->>'image_uri'
        ) as image_uri
      FROM tokens t
      WHERE t.metadata IS NOT NULL
        AND (
          t.metadata->'offChainMetadata'->>'image' IS NOT NULL
          OR t.metadata->>'image' IS NOT NULL
          OR t.metadata->>'imageUri' IS NOT NULL
          OR t.metadata->>'image_uri' IS NOT NULL
        )
      LIMIT 10
    `);
    
    console.log('Tokens with images found:');
    console.log('========================\n');
    
    result.rows.forEach((row, index) => {
      console.log(`${index + 1}. ${row.symbol} (${row.name})`);
      console.log(`   Address: ${row.mint_address}`);
      console.log(`   Image URL: ${row.image_uri}`);
      console.log('');
    });
    
    console.log(`Total tokens with images: ${result.rows.length}`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

testImageExtraction();