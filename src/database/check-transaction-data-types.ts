import { getDbPool } from './connection';

async function checkTransactionDataTypes() {
  const dbPool = getDbPool();
  
  try {
    // Check the actual values and data types
    const query = `
      SELECT 
        signature,
        type,
        sol_amount::text as sol_amount_text,
        token_amount::text as token_amount_text,
        price_per_token::text as price_text
      FROM transactions
      WHERE sol_amount IS NOT NULL
      ORDER BY block_time DESC
      LIMIT 5;
    `;
    
    const result = await dbPool.query(query);
    
    console.log('\n=== RAW TRANSACTION VALUES ===\n');
    
    for (const row of result.rows) {
      console.log(`Type: ${row.type}`);
      console.log(`SOL amount (text): ${row.sol_amount_text}`);
      console.log(`Token amount (text): ${row.token_amount_text}`);
      console.log(`Price (text): ${row.price_text}`);
      console.log(`Sig: ${row.signature.slice(0,30)}...\n`);
    }
    
    // Check column info
    const colQuery = `
      SELECT column_name, data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_name = 'transactions'
      AND column_name IN ('sol_amount', 'token_amount', 'price_per_token');
    `;
    
    const colResult = await dbPool.query(colQuery);
    console.log('\n=== COLUMN DEFINITIONS ===');
    for (const col of colResult.rows) {
      console.log(`${col.column_name}: ${col.data_type}(${col.numeric_precision},${col.numeric_scale})`);
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbPool.end();
  }
}

checkTransactionDataTypes();