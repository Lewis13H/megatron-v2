import { getDbPool } from '../connection';
import { progressiveBondingCurveScorer } from '../../scoring/progressive-bonding-curve';

async function testProgressiveCurve() {
  const pool = getDbPool();
  const client = await pool.connect();
  
  try {
    console.log('🎯 Testing Progressive Bonding Curve Scoring\n');
    console.log('This implements a bell curve that:');
    console.log('- Starts at ~0 for new tokens (prevents FOMO)');
    console.log('- Peaks at 50-55% progress (optimal entry)');
    console.log('- Declines after peak (natural exit signal)\n');
    
    // First, apply the migration
    console.log('📦 Applying progressive scoring migration...');
    const fs = require('fs');
    const path = require('path');
    const sqlPath = path.join(__dirname, '../migrations/020_progressive_bonding_curve_scoring.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
    console.log('✅ Migration applied\n');
    
    // Test SQL implementation
    console.log('📊 SQL Implementation Test Results:\n');
    console.log('Progress | Score | Phase');
    console.log('---------|-------|------------------');
    
    const testPoints = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
    
    for (const progress of testPoints) {
      const result = await client.query(
        'SELECT calculate_bonding_curve_score($1, $2) as score',
        [progress, 1.0] // Normal velocity
      );
      
      const score = parseFloat(result.rows[0].score);
      const phase = 
        progress < 5 ? 'Launch' :
        progress < 35 ? 'Proving' :
        progress < 45 ? 'Building' :
        progress <= 55 ? '🎯 OPTIMAL' :
        progress <= 75 ? 'Late' :
        'Graduation';
      
      // Visual bar representation
      const barLength = Math.round(score / 2);
      const bar = '█'.repeat(barLength);
      
      console.log(`${progress.toString().padStart(7)}% | ${score.toFixed(1).padStart(5)} | ${phase.padEnd(10)} ${bar}`);
    }
    
    console.log('\n📈 TypeScript Implementation Test:\n');
    console.log('Progress | Total | Position | Velocity | Phase');
    console.log('---------|-------|----------|----------|------------------');
    
    for (const progress of testPoints) {
      const result = progressiveBondingCurveScorer.calculate(progress, 1.0, 0.5);
      
      console.log(
        `${progress.toString().padStart(7)}% | ${result.totalScore.toFixed(1).padStart(5)} | ` +
        `${result.positionScore.toFixed(1).padStart(8)} | ${result.velocityScore.toFixed(1).padStart(8)} | ` +
        `${result.phase}`
      );
    }
    
    // Show the curve visualization
    console.log('\n📉 Score Curve Visualization:\n');
    
    const curveData = progressiveBondingCurveScorer.generateCurveData();
    const maxScore = Math.max(...curveData.map(d => d.score));
    const scale = 50; // Characters wide
    
    for (let i = 0; i < curveData.length; i += 5) { // Every 10%
      const point = curveData[i];
      const barLength = Math.round((point.score / maxScore) * scale);
      const bar = '▓'.repeat(barLength) + '░'.repeat(scale - barLength);
      
      console.log(`${point.progress.toString().padStart(3)}% |${bar}| ${point.score.toFixed(1)}`);
    }
    
    // Key insights
    console.log('\n🔑 Key Insights:\n');
    
    console.log('1. Launch Phase (0-5%):');
    console.log('   - Score: ~0-15 points');
    console.log('   - Purpose: Prevents FOMO on brand new tokens');
    console.log('   - Action: WAIT\n');
    
    console.log('2. Proving Phase (5-35%):');
    console.log('   - Score: 15-45 points');
    console.log('   - Purpose: Token must prove viability');
    console.log('   - Action: MONITOR\n');
    
    console.log('3. Momentum Building (35-45%):');
    console.log('   - Score: 45-70 points');
    console.log('   - Purpose: Identify strong candidates');
    console.log('   - Action: PREPARE ENTRY\n');
    
    console.log('4. 🎯 OPTIMAL ENTRY (45-55%):');
    console.log('   - Score: 70-83 points (MAXIMUM)');
    console.log('   - Purpose: Best risk/reward ratio');
    console.log('   - Action: FULL POSITION\n');
    
    console.log('5. Late Stage (55-75%):');
    console.log('   - Score: 50-70 points (declining)');
    console.log('   - Purpose: Signal to reduce/exit');
    console.log('   - Action: TAKE PROFITS\n');
    
    console.log('6. Graduation Risk (75%+):');
    console.log('   - Score: <50 points');
    console.log('   - Purpose: Avoid late entry');
    console.log('   - Action: NO ENTRY\n');
    
    // Check current tokens in optimal zone
    console.log('🔍 Checking for tokens currently in optimal zone...\n');
    
    const optimalTokens = await client.query(`
      SELECT 
        t.symbol,
        p.bonding_curve_progress,
        p.latest_price_usd * 1000000000 as market_cap_usd,
        calculate_bonding_curve_score(p.bonding_curve_progress, 1.0) as score
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE p.status = 'active'
        AND p.platform = 'pumpfun'
        AND p.bonding_curve_progress BETWEEN 40 AND 60
      ORDER BY score DESC
      LIMIT 5
    `);
    
    if (optimalTokens.rows.length > 0) {
      console.log('Symbol | Progress | Market Cap | Score');
      console.log('-------|----------|------------|-------');
      
      for (const token of optimalTokens.rows) {
        const progress = parseFloat(token.bonding_curve_progress || '0');
        const score = parseFloat(token.score || '0');
        const mcap = token.market_cap_usd ? `$${(token.market_cap_usd / 1000).toFixed(1)}k` : 'N/A';
        
        console.log(
          `${token.symbol.padEnd(6)} | ${progress.toFixed(1).padStart(7)}% | ${mcap.padStart(10)} | ${score.toFixed(1)}`
        );
      }
    } else {
      console.log('No tokens currently in the 40-60% optimal zone');
    }
    
  } catch (error) {
    console.error('❌ Error testing progressive curve:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run the test
testProgressiveCurve()
  .then(() => {
    console.log('\n✅ Progressive bonding curve test complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Test failed:', error);
    process.exit(1);
  });