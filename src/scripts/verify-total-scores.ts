import { getDbPool } from '../database/connection';

async function verifyTotalScores() {
  const pool = getDbPool();
  
  console.log('=== Verifying Total Score Calculation ===\n');
  
  try {
    // Test 1: Check aggregate scores table
    console.log('1. Top tokens from aggregate_scores table:');
    const aggResult = await pool.query(`
      SELECT 
        t.symbol,
        t.mint_address,
        ag.technical_score,
        ag.holder_score,
        ag.social_score,
        ag.total_score,
        ag.total_percentage
      FROM latest_aggregate_scores ag
      JOIN tokens t ON ag.token_id = t.id
      ORDER BY ag.total_score DESC
      LIMIT 5
    `);
    
    console.table(aggResult.rows.map((row: any) => ({
      Symbol: row.symbol,
      Technical: parseFloat(row.technical_score).toFixed(1),
      Holder: parseFloat(row.holder_score).toFixed(1),
      Social: parseFloat(row.social_score).toFixed(1),
      Total: parseFloat(row.total_score).toFixed(1),
      Percentage: parseFloat(row.total_percentage).toFixed(1) + '%'
    })));
    
    // Test 2: Verify calculation matches
    console.log('\n2. Verifying score calculations:');
    const verifyResult = await pool.query(`
      SELECT 
        t.symbol,
        ts.total_score as technical_from_function,
        hs.total_score as holder_from_table,
        ag.technical_score as technical_from_aggregate,
        ag.holder_score as holder_from_aggregate,
        ag.total_score as total_from_aggregate,
        COALESCE(ts.total_score, 0) + COALESCE(hs.total_score, 0) as calculated_total
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      LEFT JOIN LATERAL (
        SELECT * FROM calculate_technical_score(t.id, p.id)
      ) ts ON true
      LEFT JOIN LATERAL (
        SELECT * FROM holder_scores_v2
        WHERE token_id = t.id
        ORDER BY score_time DESC
        LIMIT 1
      ) hs ON true
      LEFT JOIN latest_aggregate_scores ag ON t.id = ag.token_id
      WHERE ag.total_score IS NOT NULL
      ORDER BY ag.total_score DESC
      LIMIT 5
    `);
    
    for (const row of verifyResult.rows) {
      const techFunc = parseFloat(row.technical_from_function || 0);
      const holderTable = parseFloat(row.holder_from_table || 0);
      const techAgg = parseFloat(row.technical_from_aggregate || 0);
      const holderAgg = parseFloat(row.holder_from_aggregate || 0);
      const totalAgg = parseFloat(row.total_from_aggregate || 0);
      const calcTotal = parseFloat(row.calculated_total || 0);
      
      console.log(`\n${row.symbol}:`);
      console.log(`  Technical: Function=${techFunc.toFixed(1)}, Aggregate=${techAgg.toFixed(1)}`);
      console.log(`  Holder: Table=${holderTable.toFixed(1)}, Aggregate=${holderAgg.toFixed(1)}`);
      console.log(`  Total: Aggregate=${totalAgg.toFixed(1)}, Calculated=${calcTotal.toFixed(1)}`);
      
      if (Math.abs(totalAgg - (techAgg + holderAgg)) > 0.1) {
        console.log(`  ⚠️ WARNING: Aggregate total doesn't match sum of components!`);
      }
    }
    
    // Test 3: Check API query
    console.log('\n3. Testing API query logic:');
    const apiQuery = `
      WITH token_data AS (
        SELECT 
          t.symbol,
          COALESCE(
            ag.total_score, 
            COALESCE(ts.total_score, 0) + COALESCE(hs.total_score, 0)
          ) as total_score,
          COALESCE(ag.technical_score, ts.total_score, 0) as technical_score,
          COALESCE(ag.holder_score, hs.total_score, 0) as holder_score
        FROM tokens t
        JOIN pools p ON t.id = p.token_id
        LEFT JOIN LATERAL (
          SELECT * FROM calculate_technical_score(t.id, p.id)
        ) ts ON true
        LEFT JOIN LATERAL (
          SELECT * FROM holder_scores_v2
          WHERE token_id = t.id
          ORDER BY score_time DESC
          LIMIT 1
        ) hs ON true
        LEFT JOIN LATERAL (
          SELECT * FROM latest_aggregate_scores
          WHERE token_id = t.id
        ) ag ON true
        WHERE t.symbol IS NOT NULL
          AND p.status = 'active'
      )
      SELECT * FROM token_data
      ORDER BY total_score DESC
      LIMIT 5
    `;
    
    const apiResult = await pool.query(apiQuery);
    
    console.table(apiResult.rows.map((row: any) => ({
      Symbol: row.symbol,
      Technical: parseFloat(row.technical_score).toFixed(1),
      Holder: parseFloat(row.holder_score).toFixed(1),
      Total: parseFloat(row.total_score).toFixed(1),
      'Calc Check': (parseFloat(row.technical_score) + parseFloat(row.holder_score)).toFixed(1)
    })));
    
    // Test 4: Check for missing scores
    console.log('\n4. Checking for tokens with missing scores:');
    const missingResult = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE ts.total_score IS NOT NULL) as has_technical,
        COUNT(*) FILTER (WHERE hs.total_score IS NOT NULL) as has_holder,
        COUNT(*) FILTER (WHERE ag.total_score IS NOT NULL) as has_aggregate,
        COUNT(*) as total_tokens
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      LEFT JOIN LATERAL (
        SELECT * FROM calculate_technical_score(t.id, p.id)
      ) ts ON true
      LEFT JOIN LATERAL (
        SELECT * FROM holder_scores_v2
        WHERE token_id = t.id
        ORDER BY score_time DESC
        LIMIT 1
      ) hs ON true
      LEFT JOIN latest_aggregate_scores ag ON t.id = ag.token_id
      WHERE p.status = 'active'
    `);
    
    const stats = missingResult.rows[0];
    console.log(`  Active tokens: ${stats.total_tokens}`);
    console.log(`  With technical scores: ${stats.has_technical} (${(stats.has_technical/stats.total_tokens*100).toFixed(1)}%)`);
    console.log(`  With holder scores: ${stats.has_holder} (${(stats.has_holder/stats.total_tokens*100).toFixed(1)}%)`);
    console.log(`  With aggregate scores: ${stats.has_aggregate} (${(stats.has_aggregate/stats.total_tokens*100).toFixed(1)}%)`);
    
    console.log('\n=== Verification Complete ===');
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

verifyTotalScores().catch(console.error);