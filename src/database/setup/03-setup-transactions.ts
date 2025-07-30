import { readFileSync } from 'fs';
import { join } from 'path';
import { getDbPool } from '../connection';

async function setupTransactionTable() {
  const pool = getDbPool();
  
  try {
    console.log('🚀 Setting up transaction hypertable...');
    
    // Read the SQL migration file
    const sqlPath = join(__dirname, '../migrations/003_create_transactions_hypertable.sql');
    const sql = readFileSync(sqlPath, 'utf8');
    
    // Execute the migration
    await pool.query(sql);
    
    console.log('✅ Transaction table created successfully');
    
    // Verify the hypertable was created
    const hypertableCheck = await pool.query(`
      SELECT * FROM timescaledb_information.hypertables 
      WHERE hypertable_name = 'transactions'
    `);
    
    if (hypertableCheck.rows.length > 0) {
      console.log('✅ Hypertable verified:', hypertableCheck.rows[0].hypertable_name);
    } else {
      console.log('❌ Hypertable not found!');
    }
    
    // Check if compression policy was added
    const compressionCheck = await pool.query(`
      SELECT * FROM timescaledb_information.compression_settings
      WHERE hypertable_name = 'transactions'
    `);
    
    if (compressionCheck.rows.length > 0) {
      console.log('✅ Compression policy configured');
    }
    
    // Check if retention policy was added (handle different TimescaleDB versions)
    try {
      const retentionCheck = await pool.query(`
        SELECT * FROM timescaledb_information.jobs 
        WHERE proc_name = 'policy_retention'
        AND hypertable_name = 'transactions'
      `);
      
      if (retentionCheck.rows.length > 0) {
        console.log('✅ Retention policy configured');
      }
    } catch (err) {
      console.log('⚠️  Could not verify retention policy (may be using different TimescaleDB version)');
    }
    
    // List all created indexes
    const indexCheck = await pool.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'transactions'
      ORDER BY indexname
    `);
    
    console.log('\\n📑 Created indexes:');
    indexCheck.rows.forEach(index => {
      console.log(`  - ${index.indexname}`);
    });
    
    console.log('\\n✅ Transaction table setup complete!');
    
  } catch (error) {
    console.error('❌ Error setting up transaction table:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  setupTransactionTable();
}