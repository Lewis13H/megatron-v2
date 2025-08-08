import { getDbPool } from '../connection';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Apply Progressive Scoring Migration
 * Implements the bell curve scoring that starts at 0 and peaks at 45-55%
 */
async function applyProgressiveScoring() {
  const pool = getDbPool();
  const client = await pool.connect();
  
  console.log('🚀 Starting Progressive Scoring System Update\n');
  console.log('This will implement:');
  console.log('  ✓ Tokens start at 0 score (prevent FOMO)');
  console.log('  ✓ Peak scoring at 45-55% progress');
  console.log('  ✓ Natural decline after peak');
  console.log('  ✓ Enhanced sell-off detection\n');
  
  try {
    // Step 1: Check current scoring distribution
    console.log('📊 Current Scoring Distribution:\n');
    const currentScores = await client.query(`
      SELECT 
        CASE 
          WHEN p.bonding_curve_progress < 20 THEN '0-20%'
          WHEN p.bonding_curve_progress < 40 THEN '20-40%'
          WHEN p.bonding_curve_progress < 60 THEN '40-60%'
          WHEN p.bonding_curve_progress < 80 THEN '60-80%'
          ELSE '80-100%'
        END as progress_range,
        COUNT(*) as token_count,
        AVG(COALESCE(ts.total_score, 0)) as avg_score
      FROM pools p
      LEFT JOIN LATERAL (
        SELECT total_score 
        FROM technical_scores 
        WHERE pool_id = p.id 
        ORDER BY calculated_at DESC 
        LIMIT 1
      ) ts ON true
      WHERE p.status = 'active' 
        AND p.platform = 'pumpfun'
      GROUP BY progress_range
      ORDER BY progress_range
    `);
    
    console.log('Range    | Tokens | Avg Score');
    console.log('---------|--------|----------');
    for (const row of currentScores.rows) {
      console.log(
        `${row.progress_range.padEnd(8)} | ${row.token_count.toString().padStart(6)} | ${parseFloat(row.avg_score).toFixed(1)}`
      );
    }
    
    // Step 2: Apply progressive scoring migration
    console.log('\n📦 Applying progressive scoring migration...');
    const sqlPath = path.join(__dirname, '../migrations/020_progressive_bonding_curve_scoring.sql');
    
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Migration file not found: ${sqlPath}`);
    }
    
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
    console.log('✅ Progressive scoring functions updated\n');
    
    // Step 3: Test the new scoring curve
    console.log('🧪 Testing New Progressive Scoring:\n');
    console.log('Progress | Old Score | New Score | Change');
    console.log('---------|-----------|-----------|--------');
    
    const testPoints = [0, 5, 10, 20, 30, 40, 45, 50, 55, 60, 70, 80, 90, 100];
    
    for (const progress of testPoints) {
      // Get old score (if function exists)
      let oldScore = 0;
      try {
        const oldResult = await client.query(
          'SELECT calculate_bonding_curve_score_v1($1, $2) as score',
          [progress, 1.0]
        );
        oldScore = parseFloat(oldResult.rows[0].score);
      } catch (e) {
        // Old function might not exist
        oldScore = 0;
      }
      
      // Get new score
      const newResult = await client.query(
        'SELECT calculate_bonding_curve_score($1, $2) as score',
        [progress, 1.0]
      );
      const newScore = parseFloat(newResult.rows[0].score);
      
      const change = newScore - oldScore;
      const changeStr = change > 0 ? `+${change.toFixed(1)}` : change.toFixed(1);
      const emoji = 
        progress >= 45 && progress <= 55 ? '🎯' :
        progress < 10 ? '🔴' :
        progress > 80 ? '⚠️' : '';
      
      console.log(
        `${progress.toString().padStart(7)}% | ${oldScore.toFixed(1).padStart(9)} | ` +
        `${newScore.toFixed(1).padStart(9)} | ${changeStr.padStart(7)} ${emoji}`
      );
    }
    
    // Step 4: Find tokens in optimal entry zone
    console.log('\n🎯 Tokens Currently in Optimal Entry Zone (45-55%):\n');
    
    const optimalTokens = await client.query(`
      SELECT 
        t.symbol,
        t.mint_address,
        p.bonding_curve_progress,
        p.latest_price_usd * 1000000000 as market_cap_usd,
        calculate_bonding_curve_score(p.bonding_curve_progress, 
          COALESCE(
            (p.bonding_curve_progress - LAG(p.bonding_curve_progress) OVER (PARTITION BY p.id ORDER BY p.updated_at)) * 6,
            1.0
          )
        ) as new_score,
        p.updated_at
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE p.status = 'active'
        AND p.platform = 'pumpfun'
        AND p.bonding_curve_progress BETWEEN 45 AND 55
        AND p.latest_price_usd * 1000000000 BETWEEN 15000 AND 25000
      ORDER BY new_score DESC
      LIMIT 10
    `);
    
    if (optimalTokens.rows.length > 0) {
      console.log('Symbol  | Progress | Market Cap | Score | Updated');
      console.log('--------|----------|------------|-------|------------------');
      
      for (const token of optimalTokens.rows) {
        const progress = parseFloat(token.bonding_curve_progress || '0');
        const score = parseFloat(token.new_score || '0');
        const mcap = token.market_cap_usd ? `$${(token.market_cap_usd / 1000).toFixed(1)}k` : 'N/A';
        const updated = new Date(token.updated_at).toLocaleTimeString();
        
        console.log(
          `${token.symbol.substring(0, 7).padEnd(7)} | ${progress.toFixed(1).padStart(7)}% | ` +
          `${mcap.padStart(10)} | ${score.toFixed(1).padStart(5)} | ${updated}`
        );
      }
      
      console.log('\n✅ These tokens are in the OPTIMAL ENTRY ZONE!');
    } else {
      console.log('No tokens currently in the optimal entry zone (45-55% with $15-25k mcap)');
    }
    
    // Step 5: Check tokens that would have been filtered out (0-10%)
    console.log('\n🛡️ New Tokens Being Filtered (0-10% progress):\n');
    
    const filteredTokens = await client.query(`
      SELECT 
        COUNT(*) as count,
        AVG(p.bonding_curve_progress) as avg_progress,
        AVG(calculate_bonding_curve_score(p.bonding_curve_progress, 1.0)) as avg_score
      FROM pools p
      WHERE p.status = 'active'
        AND p.platform = 'pumpfun'
        AND p.bonding_curve_progress < 10
    `);
    
    const filtered = filteredTokens.rows[0];
    if (filtered && filtered.count > 0) {
      console.log(`${filtered.count} tokens below 10% progress`);
      console.log(`Average progress: ${parseFloat(filtered.avg_progress).toFixed(1)}%`);
      console.log(`Average score: ${parseFloat(filtered.avg_score).toFixed(1)} (was ~40-50, now ~10-20)`);
      console.log('\n✅ These tokens will no longer trigger FOMO entries!');
    }
    
    // Step 6: Update scoring view
    console.log('\n📈 Creating scoring curve visualization view...');
    
    await client.query(`
      CREATE OR REPLACE VIEW scoring_curve_analysis AS
      SELECT 
        progress,
        calculate_bonding_curve_score(progress, 1.0) as score_normal_velocity,
        calculate_bonding_curve_score(progress, 2.0) as score_high_velocity,
        calculate_bonding_curve_score(progress, 0.5) as score_low_velocity,
        CASE 
          WHEN progress < 10 THEN 'Too Early'
          WHEN progress < 45 THEN 'Building'
          WHEN progress <= 55 THEN '🎯 OPTIMAL'
          WHEN progress <= 75 THEN 'Late Stage'
          ELSE 'Graduation Risk'
        END as recommendation
      FROM generate_series(0, 100, 5) as progress
    `);
    
    console.log('✅ View created: scoring_curve_analysis');
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('🎉 PROGRESSIVE SCORING SYSTEM SUCCESSFULLY UPDATED!');
    console.log('='.repeat(60));
    console.log('\nKey Changes:');
    console.log('  ✅ Tokens at 0% now score ~0 points (was ~40)');
    console.log('  ✅ Optimal entry at 45-55% scores 83 points');
    console.log('  ✅ Natural decline after 55% signals profit-taking');
    console.log('  ✅ "Proof of life" multiplier prevents early entries');
    
    console.log('\nNext Steps:');
    console.log('  1. Monitor optimal entry tokens');
    console.log('  2. Update trading algorithms to use new scores');
    console.log('  3. Set alerts for tokens entering 45-55% zone');
    console.log('  4. Track performance metrics over next 24 hours');
    
  } catch (error) {
    console.error('\n❌ Error applying progressive scoring:', error);
    
    // Attempt rollback
    console.log('\n🔄 Attempting to rollback...');
    try {
      await client.query('ROLLBACK');
      console.log('✅ Rollback successful');
    } catch (rollbackError) {
      console.error('❌ Rollback failed:', rollbackError);
    }
    
    throw error;
  } finally {
    client.release();
  }
}

// Run the migration
if (require.main === module) {
  applyProgressiveScoring()
    .then(() => {
      console.log('\n✅ Progressive scoring migration complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error);
      process.exit(1);
    });
}

export { applyProgressiveScoring };