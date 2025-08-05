import * as dotenv from 'dotenv';
import { getDbPool } from '../connection';

dotenv.config();

async function fixTechnicalScoringFunctions() {
  console.log('🔧 Fixing Technical Scoring Functions...\n');
  
  const pool = getDbPool();
  const client = await pool.connect();
  
  try {
    // Drop and recreate the calculate_technical_score function
    console.log('📝 Updating calculate_technical_score function...');
    
    await client.query('DROP FUNCTION IF EXISTS calculate_technical_score(UUID, UUID)');
    
    await client.query(`
CREATE OR REPLACE FUNCTION calculate_technical_score(
    p_token_id UUID,
    p_pool_id UUID
) RETURNS TABLE (
    total_score NUMERIC,
    market_cap_score NUMERIC,
    bonding_curve_score NUMERIC,
    trading_health_score NUMERIC,
    selloff_response_score NUMERIC,
    market_cap_usd NUMERIC,
    bonding_curve_progress NUMERIC,
    buy_sell_ratio NUMERIC,
    is_selloff_active BOOLEAN
) AS $$
DECLARE
    v_market_cap_usd NUMERIC;
    v_bonding_curve_progress NUMERIC;
    v_progress_velocity NUMERIC;
    v_buy_sell_ratio NUMERIC;
    v_volume_trend NUMERIC;
    v_whale_concentration NUMERIC;
    v_price_drop_5min NUMERIC;
    v_recovery_strength NUMERIC;
    v_market_cap_score NUMERIC;
    v_bonding_curve_score NUMERIC;
    v_trading_health_score NUMERIC;
    v_selloff_response_score NUMERIC;
BEGIN
    -- Get current pool data (fixed ambiguous reference)
    SELECT 
        p.latest_price_usd * 1000000000, -- 1B token supply
        p.bonding_curve_progress
    INTO v_market_cap_usd, v_bonding_curve_progress
    FROM pools p
    WHERE p.id = p_pool_id;
    
    -- Calculate progress velocity (% per hour) - fixed ambiguous references
    SELECT 
        (MAX(prog) - MIN(prog)) * 12
    INTO v_progress_velocity
    FROM (
        SELECT p.bonding_curve_progress as prog
        FROM pools p
        WHERE p.id = p_pool_id
        UNION ALL
        SELECT ts.bonding_curve_progress as prog
        FROM technical_scores ts
        WHERE ts.pool_id = p_pool_id
        AND ts.calculated_at > NOW() - INTERVAL '5 minutes'
    ) progress_history;
    
    -- Calculate buy/sell ratio from recent transactions
    SELECT 
        COALESCE(
            SUM(CASE WHEN type = 'buy' THEN sol_amount ELSE 0 END) / 
            NULLIF(SUM(CASE WHEN type = 'sell' THEN sol_amount ELSE 0 END), 0),
            2.0
        )
    INTO v_buy_sell_ratio
    FROM transactions
    WHERE pool_id = p_pool_id
    AND block_time > NOW() - INTERVAL '30 minutes';
    
    -- Calculate volume trend (% increase from 30min to 5min window)
    WITH volume_windows AS (
        SELECT 
            SUM(CASE WHEN block_time > NOW() - INTERVAL '5 minutes' THEN sol_amount ELSE 0 END) as vol_5min,
            SUM(CASE WHEN block_time > NOW() - INTERVAL '30 minutes' THEN sol_amount ELSE 0 END) as vol_30min
        FROM transactions
        WHERE pool_id = p_pool_id
        AND block_time > NOW() - INTERVAL '30 minutes'
    )
    SELECT 
        CASE 
            WHEN vol_30min > 0 THEN ((vol_5min * 6) - vol_30min) / vol_30min * 100
            ELSE 0
        END
    INTO v_volume_trend
    FROM volume_windows;
    
    -- Calculate whale concentration (top wallet % of volume)
    WITH wallet_volumes AS (
        SELECT 
            user_address,
            SUM(sol_amount) as wallet_volume,
            SUM(SUM(sol_amount)) OVER () as total_volume
        FROM transactions
        WHERE pool_id = p_pool_id
        AND block_time > NOW() - INTERVAL '1 hour'
        GROUP BY user_address
    )
    SELECT COALESCE(MAX(wallet_volume / NULLIF(total_volume, 0)), 0)
    INTO v_whale_concentration
    FROM wallet_volumes;
    
    -- Calculate price drop in last 5 minutes
    WITH price_history AS (
        SELECT 
            price_per_token,
            block_time,
            FIRST_VALUE(price_per_token) OVER (ORDER BY block_time DESC) as current_price,
            FIRST_VALUE(price_per_token) OVER (ORDER BY block_time ASC) as price_5min_ago
        FROM transactions
        WHERE pool_id = p_pool_id
        AND block_time > NOW() - INTERVAL '5 minutes'
        AND price_per_token IS NOT NULL
    )
    SELECT 
        CASE 
            WHEN MAX(price_5min_ago) > 0 THEN 
                (MAX(price_5min_ago) - MAX(current_price)) / MAX(price_5min_ago) * 100
            ELSE 0
        END
    INTO v_price_drop_5min
    FROM price_history;
    
    -- Calculate recovery strength (buy volume after price drops)
    WITH price_drops AS (
        SELECT 
            block_time,
            price_per_token,
            LAG(price_per_token) OVER (ORDER BY block_time) as prev_price
        FROM transactions
        WHERE pool_id = p_pool_id
        AND block_time > NOW() - INTERVAL '30 minutes'
        AND price_per_token IS NOT NULL
    ),
    drop_events AS (
        SELECT block_time
        FROM price_drops
        WHERE prev_price > 0 AND price_per_token < prev_price * 0.95
    )
    SELECT 
        COALESCE(
            SUM(CASE WHEN t.type = 'buy' AND t.block_time > de.block_time THEN t.sol_amount ELSE 0 END) /
            NULLIF(SUM(CASE WHEN t.type = 'sell' AND t.block_time <= de.block_time THEN t.sol_amount ELSE 0 END), 0),
            1.0
        )
    INTO v_recovery_strength
    FROM transactions t
    CROSS JOIN drop_events de
    WHERE t.pool_id = p_pool_id
    AND t.block_time BETWEEN de.block_time - INTERVAL '1 minute' AND de.block_time + INTERVAL '5 minutes';
    
    -- Calculate component scores
    v_market_cap_score := calculate_market_cap_score(COALESCE(v_market_cap_usd, 0));
    v_bonding_curve_score := calculate_bonding_curve_score(
        COALESCE(v_bonding_curve_progress, 0), 
        COALESCE(v_progress_velocity, 0)
    );
    v_trading_health_score := calculate_trading_health_score(
        COALESCE(v_buy_sell_ratio, 1), 
        COALESCE(v_volume_trend, 0), 
        COALESCE(v_whale_concentration, 0)
    );
    v_selloff_response_score := calculate_selloff_response_score(
        COALESCE(v_price_drop_5min, 0), 
        COALESCE(v_recovery_strength, 1)
    );
    
    RETURN QUERY SELECT 
        v_market_cap_score + v_bonding_curve_score + v_trading_health_score + v_selloff_response_score,
        v_market_cap_score,
        v_bonding_curve_score,
        v_trading_health_score,
        v_selloff_response_score,
        v_market_cap_usd,
        v_bonding_curve_progress,
        v_buy_sell_ratio,
        v_price_drop_5min > 10; -- is_selloff_active
END;
$$ LANGUAGE plpgsql;
    `);
    
    console.log('✅ Function updated successfully\n');
    
    // Test the function
    console.log('🧪 Testing the updated function...');
    
    // Get a test token/pool
    const testResult = await client.query(`
      SELECT t.id as token_id, p.id as pool_id
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE t.platform = 'pumpfun'
      AND p.latest_price IS NOT NULL
      LIMIT 1
    `);
    
    if (testResult.rows.length > 0) {
      const { token_id, pool_id } = testResult.rows[0];
      const scoreResult = await client.query(
        'SELECT * FROM calculate_technical_score($1::uuid, $2::uuid)',
        [token_id, pool_id]
      );
      
      if (scoreResult.rows.length > 0) {
        console.log('✅ Function test successful!');
        console.log('   Sample score:', scoreResult.rows[0].total_score);
      }
    }
    
    console.log('\n🎉 Technical scoring functions fixed successfully!');
    
  } catch (error) {
    console.error('❌ Error updating functions:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run the fix
fixTechnicalScoringFunctions()
  .then(() => {
    console.log('\n✅ Fix completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Fix failed:', error);
    process.exit(1);
  });