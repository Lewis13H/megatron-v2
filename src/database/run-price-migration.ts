import { getDbPool } from './connection';
import fs from 'fs';
import path from 'path';

async function runPriceMigration() {
  const pool = getDbPool();
  
  try {
    // Read migration SQL
    const migrationPath = path.join(__dirname, 'migrations', '006_add_latest_price_to_pools.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    console.log('Running price column migration...');
    await pool.query(sql);
    
    console.log('✅ Migration completed successfully');
    console.log('Added latest_price column to pools table');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await pool.end();
  }
}

runPriceMigration();