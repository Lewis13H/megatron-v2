import { getDbPool } from '../connection';
import * as fs from 'fs';
import * as path from 'path';

async function applyBondingCurveFix() {
  const pool = getDbPool();
  const client = await pool.connect();
  
  try {
    console.log('🔧 Applying bonding curve scoring fix...');
    
    // Read the migration SQL file
    const sqlPath = path.join(__dirname, '../migrations/019_fix_bonding_curve_scoring.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Execute the migration
    await client.query(sql);
    
    console.log('✅ Bonding curve scoring function updated successfully');
    
    // Test the new scoring with different progress values
    console.log('\n📊 Testing new scoring alignment with thesis:\n');
    
    const testCases = [
      { progress: 5, velocity: 1.0, description: 'Very early (5%)' },
      { progress: 20, velocity: 1.0, description: 'Early (20%)' },
      { progress: 35, velocity: 1.0, description: 'Approaching optimal (35%)' },
      { progress: 45, velocity: 1.0, description: '🎯 SWEET SPOT (45%)' },
      { progress: 55, velocity: 1.0, description: '🎯 SWEET SPOT (55%)' },
      { progress: 70, velocity: 1.0, description: 'Late accumulation (70%)' },
      { progress: 85, velocity: 1.0, description: 'Too late (85%)' },
    ];
    
    for (const test of testCases) {
      const result = await client.query(
        'SELECT calculate_bonding_curve_score($1, $2) as score',
        [test.progress, test.velocity]
      );
      
      const score = parseFloat(result.rows[0].score);
      const emoji = test.progress >= 40 && test.progress <= 60 ? '🟢' : 
                    test.progress >= 30 && test.progress <= 80 ? '🟡' : '🔴';
      
      console.log(`${emoji} ${test.description}: ${score.toFixed(1)}/83 points`);
    }
    
    // Check for tokens currently in optimal zone
    console.log('\n🔍 Checking for tokens in optimal entry zone (40-80% progress)...\n');
    
    const optimalTokens = await client.query(`
      SELECT 
        t.symbol,
        p.bonding_curve_progress,
        p.latest_price_usd * 1000000000 as market_cap_usd,
        is_in_optimal_entry_zone(p.bonding_curve_progress, p.latest_price_usd * 1000000000) as in_optimal_zone
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE p.status = 'active'
        AND p.platform = 'pumpfun'
        AND p.bonding_curve_progress BETWEEN 35 AND 85
      ORDER BY p.bonding_curve_progress DESC
      LIMIT 10
    `);
    
    if (optimalTokens.rows.length > 0) {
      console.log('Token | Progress | Market Cap | In Optimal Zone');
      console.log('------|----------|------------|----------------');
      
      for (const token of optimalTokens.rows) {
        const zone = token.in_optimal_zone ? '✅ YES' : '❌ NO';
        const mcapFormatted = token.market_cap_usd 
          ? `$${(token.market_cap_usd / 1000).toFixed(1)}k` 
          : 'N/A';
        
        const progress = parseFloat(token.bonding_curve_progress || '0');
        console.log(
          `${token.symbol.padEnd(5)} | ${progress.toFixed(1).padStart(7)}% | ${mcapFormatted.padStart(10)} | ${zone}`
        );
      }
    } else {
      console.log('No active tokens found in the 35-85% progress range');
    }
    
    console.log('\n✅ Bonding curve scoring now aligned with thesis requirements:');
    console.log('   - Optimal entry: 40-60% progress (max points)');
    console.log('   - Acceptable: 60-80% progress (good points)');
    console.log('   - Early warning: <40% progress (reduced points)');
    console.log('   - Velocity optimal: 0.5-2% per hour');
    
  } catch (error) {
    console.error('❌ Error applying bonding curve fix:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run the migration
applyBondingCurveFix()
  .then(() => {
    console.log('\n🎉 Migration completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Migration failed:', error);
    process.exit(1);
  });