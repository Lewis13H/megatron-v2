import * as dotenv from 'dotenv';
import { getDbPool } from '../connection';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

async function setupPools() {
  console.log('🏗️  Setting up pools table...\n');
  
  const pool = getDbPool();
  const client = await pool.connect();
  
  try {
    // Read and execute the migration SQL
    const migrationPath = path.join(__dirname, '..', 'migrations', '002_create_pools.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    console.log('📝 Creating pools table and indexes...');
    await client.query(migrationSQL);
    console.log('✅ Pools table created successfully\n');
    
    // Verify the table was created
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'pools'
      );
    `);
    
    if (!tableCheck.rows[0].exists) {
      throw new Error('Pools table was not created');
    }
    
    // Check indexes
    const indexCheck = await client.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'pools' 
      AND schemaname = 'public'
      ORDER BY indexname;
    `);
    
    console.log('📊 Created indexes:');
    indexCheck.rows.forEach(row => {
      console.log(`   - ${row.indexname}`);
    });
    
    // Get table structure
    const columnCheck = await client.query(`
      SELECT 
        column_name,
        data_type,
        character_maximum_length,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_name = 'pools'
      AND table_schema = 'public'
      ORDER BY ordinal_position;
    `);
    
    console.log('\n📋 Table structure:');
    console.log('┌─────────────────────────┬──────────────────┬──────────┬─────────────┐');
    console.log('│ Column                  │ Type             │ Nullable │ Default     │');
    console.log('├─────────────────────────┼──────────────────┼──────────┼─────────────┤');
    
    columnCheck.rows.forEach(col => {
      const columnName = col.column_name.padEnd(23);
      const dataType = (col.data_type + (col.character_maximum_length ? `(${col.character_maximum_length})` : '')).padEnd(16);
      const nullable = col.is_nullable.padEnd(8);
      const defaultVal = (col.column_default || '').substring(0, 11);
      
      console.log(`│ ${columnName} │ ${dataType} │ ${nullable} │ ${defaultVal.padEnd(11)} │`);
    });
    
    console.log('└─────────────────────────┴──────────────────┴──────────┴─────────────┘');
    
    console.log('\n✅ Pools table setup completed successfully!');
    
  } catch (error) {
    console.error('❌ Error setting up pools table:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Add to package.json scripts
console.log('\n📦 Add this to your package.json scripts:');
console.log('  "db:setup:pools": "tsx src/database/setup/02-setup-pools.ts"\n');

// Run the setup
setupPools()
  .then(() => {
    console.log('\n🎉 Setup complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Setup failed:', error);
    process.exit(1);
  });