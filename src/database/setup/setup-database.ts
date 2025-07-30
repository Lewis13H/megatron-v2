import { pool } from '../config';
import fs from 'fs';
import path from 'path';

async function setupDatabase() {
  console.log('🚀 Starting database setup...\n');
  
  const client = await pool.connect();
  
  try {
    // Read and execute SQL setup script
    const sqlPath = path.join(__dirname, '01-create-tokens-table.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    console.log('📝 Creating tokens table and indexes...');
    await client.query(sql);
    
    // Verify extensions
    const extensionsResult = await client.query(`
      SELECT extname, extversion 
      FROM pg_extension 
      WHERE extname IN ('uuid-ossp', 'timescaledb')
    `);
    
    console.log('\n✅ Installed extensions:');
    extensionsResult.rows.forEach(ext => {
      console.log(`   - ${ext.extname} v${ext.extversion}`);
    });
    
    // Verify table creation
    const tableResult = await client.query(`
      SELECT 
        table_name,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'tokens') as column_count,
        (SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'tokens') as index_count
      FROM information_schema.tables
      WHERE table_name = 'tokens'
    `);
    
    if (tableResult.rows.length > 0) {
      const info = tableResult.rows[0];
      console.log('\n✅ Table created successfully:');
      console.log(`   - Table: ${info.table_name}`);
      console.log(`   - Columns: ${info.column_count}`);
      console.log(`   - Indexes: ${info.index_count}`);
    }
    
    console.log('\n🎉 Database setup completed successfully!');
    
  } catch (error) {
    console.error('❌ Setup failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run setup if called directly
if (require.main === module) {
  setupDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { setupDatabase };