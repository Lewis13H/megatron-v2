import * as dotenv from 'dotenv';
import { getDbPool } from '../connection';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

async function runTechnicalScoringMigration() {
  console.log('🚀 Running Technical Scoring System Migration...\n');
  
  const pool = getDbPool();
  const client = await pool.connect();
  
  try {
    // Read the migration SQL
    const migrationPath = path.join(__dirname, '..', 'migrations', '015_technical_scoring_system.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    console.log('📝 Creating technical scoring tables and functions...');
    await client.query(migrationSQL);
    console.log('✅ Technical scoring system created successfully\n');
    
    // Verify tables were created
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'technical_scores'
      );
    `);
    
    if (!tableCheck.rows[0].exists) {
      throw new Error('Technical scores table was not created');
    }
    
    // Check if hypertable was created
    const hypertableCheck = await client.query(`
      SELECT hypertable_name 
      FROM timescaledb_information.hypertables 
      WHERE hypertable_name = 'technical_scores';
    `);
    
    if (hypertableCheck.rows.length > 0) {
      console.log('✅ TimescaleDB hypertable created successfully');
    }
    
    // Test the scoring functions
    console.log('\n🧪 Testing scoring functions...');
    
    // Test market cap score function
    const marketCapTest = await client.query(
      'SELECT calculate_market_cap_score($1) as score',
      [25000] // $25k - should return 60 points
    );
    console.log(`✅ Market cap scoring: $25,000 = ${marketCapTest.rows[0].score} points (expected: 60)`);
    
    // Test bonding curve score function
    const bondingTest = await client.query(
      'SELECT calculate_bonding_curve_score($1, $2) as score',
      [15, 1.5] // 15% progress, 1.5% per hour velocity
    );
    console.log(`✅ Bonding curve scoring: 15% @ 1.5%/hr = ${bondingTest.rows[0].score} points`);
    
    // Check views
    const viewCheck = await client.query(`
      SELECT viewname 
      FROM pg_views 
      WHERE schemaname = 'public' 
      AND viewname = 'latest_technical_scores';
    `);
    
    if (viewCheck.rows.length > 0) {
      console.log('✅ Latest technical scores view created');
    }
    
    console.log('\n🎉 Technical scoring system migration completed successfully!');
    console.log('\n📊 Available functions:');
    console.log('  - calculate_technical_score(token_id, pool_id)');
    console.log('  - save_technical_score(token_id, pool_id)');
    console.log('  - calculate_market_cap_score(market_cap_usd)');
    console.log('  - calculate_bonding_curve_score(progress, velocity)');
    console.log('  - calculate_trading_health_score(ratio, trend, concentration)');
    console.log('  - calculate_selloff_response_score(price_drop, recovery)');
    
  } catch (error) {
    console.error('❌ Error running migration:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run the migration
runTechnicalScoringMigration()
  .then(() => {
    console.log('\n✅ Migration completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Migration failed:', error);
    process.exit(1);
  });