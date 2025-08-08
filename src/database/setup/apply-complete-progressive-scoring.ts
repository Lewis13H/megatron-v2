import { getDbPool } from '../connection';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Apply Complete Progressive Scoring System
 * - No hardcoded values (all configurable)
 * - Both bonding curve and market cap follow bell curves
 * - Market cap optimal range: $25k-$45k (was $15k-$30k)
 */
async function applyCompleteProgressiveScoring() {
  const pool = getDbPool();
  const client = await pool.connect();
  
  console.log('🚀 Applying Complete Progressive Scoring System\n');
  console.log('Key Features:');
  console.log('  ✓ NO hardcoded values - all configurable');
  console.log('  ✓ Market cap progressive scoring ($25k-$45k optimal)');
  console.log('  ✓ Bonding curve progressive scoring (45-55% optimal)');
  console.log('  ✓ Configuration stored in database\n');
  
  try {
    // Step 1: Apply the migration
    console.log('📦 Applying migration 021_progressive_scoring_complete.sql...');
    const sqlPath = path.join(__dirname, '../migrations/021_progressive_scoring_complete.sql');
    
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Migration file not found: ${sqlPath}`);
    }
    
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
    console.log('✅ Migration applied successfully\n');
    
    // Step 2: Show configuration
    console.log('📊 Current Scoring Configuration:\n');
    
    const config = await client.query(`
      SELECT component, parameter, value, description
      FROM scoring_config
      ORDER BY component, parameter
    `);
    
    let currentComponent = '';
    for (const row of config.rows) {
      if (row.component !== currentComponent) {
        currentComponent = row.component;
        console.log(`\n${currentComponent.toUpperCase().replace('_', ' ')}:`);
      }
      console.log(`  ${row.parameter}: ${row.value} - ${row.description || ''}`);
    }
    
    // Step 3: Test the scoring matrix
    console.log('\n\n📈 Testing Progressive Scoring Matrix:\n');
    console.log('BC%  | MCap    | BC Score | MCap Score | Total | Status');
    console.log('-----|---------|----------|------------|-------|----------------');
    
    const testMatrix = await client.query('SELECT * FROM scoring_test_matrix');
    
    for (const row of testMatrix.rows) {
      const bcProgress = parseFloat(row.bonding_curve_progress);
      const mcap = parseFloat(row.market_cap_usd);
      const bcScore = parseFloat(row.bc_score);
      const mcapScore = parseFloat(row.mcap_score);
      const total = parseFloat(row.combined_score);
      
      console.log(
        `${bcProgress.toFixed(0).padStart(3)}% | ` +
        `$${(mcap/1000).toFixed(0)}k`.padEnd(7) + ' | ' +
        `${bcScore.toFixed(1).padStart(8)} | ` +
        `${mcapScore.toFixed(1).padStart(10)} | ` +
        `${total.toFixed(1).padStart(5)} | ` +
        `${row.status}`
      );
    }
    
    // Step 4: Show the bell curves visually
    console.log('\n\n📉 Bonding Curve Score Distribution:');
    console.log('Progress: 0%   10%  20%  30%  40%  50%  60%  70%  80%  90%  100%');
    console.log('Score:    ');
    
    let bcCurve = '';
    for (let i = 0; i <= 100; i += 10) {
      const result = await client.query(
        'SELECT calculate_bonding_curve_score($1, 1.0) as score',
        [i]
      );
      const score = parseFloat(result.rows[0].score);
      const height = Math.round(score / 83 * 10);
      bcCurve += '█'.repeat(height).padEnd(8);
    }
    console.log(bcCurve);
    
    console.log('\n📉 Market Cap Score Distribution:');
    console.log('MCap:  $6k  $15k $25k $35k $45k $55k $65k');
    console.log('Score: ');
    
    let mcCurve = '';
    const mcapPoints = [6000, 15000, 25000, 35000, 45000, 55000, 65000];
    for (const mcap of mcapPoints) {
      const result = await client.query(
        'SELECT calculate_market_cap_score($1) as score',
        [mcap]
      );
      const score = parseFloat(result.rows[0].score);
      const height = Math.round(score / 60 * 10);
      mcCurve += '█'.repeat(height).padEnd(9);
    }
    console.log(mcCurve);
    
    // Step 5: Find tokens at different stages
    console.log('\n\n🔍 Analyzing Current Token Distribution:\n');
    
    const distribution = await client.query(`
      WITH current_tokens AS (
        SELECT 
          t.symbol,
          p.bonding_curve_progress,
          p.latest_price_usd * 1000000000 as market_cap_usd,
          calculate_bonding_curve_score(p.bonding_curve_progress, 1.0) as bc_score,
          calculate_market_cap_score(p.latest_price_usd * 1000000000) as mcap_score,
          CASE 
            WHEN p.bonding_curve_progress < 10 THEN 1
            WHEN p.bonding_curve_progress < 30 THEN 2
            WHEN p.bonding_curve_progress < 45 THEN 3
            WHEN p.bonding_curve_progress <= 55 THEN 4
            WHEN p.bonding_curve_progress <= 75 THEN 5
            ELSE 6
          END as phase_order,
          CASE 
            WHEN p.bonding_curve_progress < 10 THEN '0-10% (Launch)'
            WHEN p.bonding_curve_progress < 30 THEN '10-30% (Proving)'
            WHEN p.bonding_curve_progress < 45 THEN '30-45% (Building)'
            WHEN p.bonding_curve_progress <= 55 THEN '45-55% (OPTIMAL)'
            WHEN p.bonding_curve_progress <= 75 THEN '55-75% (Declining)'
            ELSE '75%+ (Late)'
          END as phase_name
        FROM tokens t
        JOIN pools p ON t.id = p.token_id
        WHERE p.status = 'active' AND p.platform = 'pumpfun'
      )
      SELECT 
        phase_name as phase,
        COUNT(*) as token_count,
        AVG(bc_score) as avg_bc_score,
        AVG(mcap_score) as avg_mcap_score,
        AVG(bc_score + mcap_score) as avg_total,
        MIN(phase_order) as sort_order
      FROM current_tokens
      GROUP BY phase_name
      ORDER BY sort_order
    `);
    
    console.log('Phase             | Tokens | Avg BC | Avg MCap | Avg Total');
    console.log('------------------|--------|--------|----------|----------');
    
    for (const row of distribution.rows) {
      console.log(
        `${row.phase.padEnd(17)} | ${row.token_count.toString().padStart(6)} | ` +
        `${parseFloat(row.avg_bc_score).toFixed(1).padStart(6)} | ` +
        `${parseFloat(row.avg_mcap_score).toFixed(1).padStart(8)} | ` +
        `${parseFloat(row.avg_total).toFixed(1).padStart(9)}`
      );
    }
    
    // Step 6: Find tokens in optimal zone
    console.log('\n\n🎯 Tokens in Optimal Zone (45-55% BC, $25-45k MCap):\n');
    
    const optimalTokens = await client.query(`
      SELECT 
        t.symbol,
        t.mint_address,
        p.bonding_curve_progress,
        p.latest_price_usd * 1000000000 as market_cap_usd,
        calculate_bonding_curve_score(p.bonding_curve_progress, 1.0) + 
        calculate_market_cap_score(p.latest_price_usd * 1000000000) as total_score
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE p.status = 'active'
        AND p.platform = 'pumpfun'
        AND p.bonding_curve_progress BETWEEN 45 AND 55
        AND p.latest_price_usd * 1000000000 BETWEEN 25000 AND 45000
      ORDER BY total_score DESC
      LIMIT 10
    `);
    
    if (optimalTokens.rows.length > 0) {
      console.log('Symbol | BC%  | Market Cap | Score');
      console.log('-------|------|------------|-------');
      
      for (const token of optimalTokens.rows) {
        const bc = parseFloat(token.bonding_curve_progress);
        const mcap = parseFloat(token.market_cap_usd);
        const score = parseFloat(token.total_score);
        
        console.log(
          `${token.symbol.substring(0, 6).padEnd(6)} | ${bc.toFixed(1)}% | ` +
          `$${(mcap/1000).toFixed(0)}k`.padEnd(10) + ' | ' +
          `${score.toFixed(1)}`
        );
      }
    } else {
      console.log('No tokens currently in optimal zone');
    }
    
    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('✅ COMPLETE PROGRESSIVE SCORING SYSTEM APPLIED!');
    console.log('='.repeat(70));
    
    console.log('\n📋 Summary of Changes:');
    console.log('  1. All values now configurable (no hardcoding)');
    console.log('  2. Market cap scoring follows bell curve');
    console.log('  3. Optimal market cap: $25k-$45k');
    console.log('  4. Optimal bonding curve: 45-55%');
    console.log('  5. Configuration stored in scoring_config table');
    
    console.log('\n🔧 To adjust configuration:');
    console.log("  UPDATE scoring_config SET value = X WHERE component = 'Y' AND parameter = 'Z';");
    console.log('  Or use: SELECT update_scoring_config(component, parameter, value);');
    
  } catch (error) {
    console.error('\n❌ Error applying progressive scoring:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run if called directly
if (require.main === module) {
  applyCompleteProgressiveScoring()
    .then(() => {
      console.log('\n✅ Complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Failed:', error);
      process.exit(1);
    });
}

export { applyCompleteProgressiveScoring };