-- Migration: 015_create_technical_scoring_system
-- Description: Creates technical scoring system for pump.fun tokens with dynamic calculations
-- Dependencies: 001_create_tokens_table, 002_create_pools_table, 003_create_transactions_hypertable

-- Create table to store technical scores with history
CREATE TABLE technical_scores (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    pool_id UUID REFERENCES pools(id) NOT NULL,
    
    -- Overall score
    total_score NUMERIC(5,2) NOT NULL CHECK (total_score >= 0 AND total_score <= 333),
    
    -- Component scores
    market_cap_score NUMERIC(5,2) NOT NULL CHECK (market_cap_score >= 0 AND market_cap_score <= 100),
    bonding_curve_score NUMERIC(5,2) NOT NULL CHECK (bonding_curve_score >= 0 AND bonding_curve_score <= 83),
    trading_health_score NUMERIC(5,2) NOT NULL CHECK (trading_health_score >= 0 AND trading_health_score <= 75),
    selloff_response_score NUMERIC(5,2) NOT NULL CHECK (selloff_response_score >= -40 AND selloff_response_score <= 75),
    
    -- Snapshot data
    market_cap_usd NUMERIC(20,2),
    bonding_curve_progress NUMERIC(5,2),
    buy_sell_ratio NUMERIC(10,2),
    volume_5min NUMERIC(20,9),
    volume_15min NUMERIC(20,9),
    volume_30min NUMERIC(20,9),
    
    -- Velocity metrics
    progress_velocity_per_hour NUMERIC(10,4),
    market_cap_velocity_per_min NUMERIC(10,4),
    
    -- Sell-off detection
    is_selloff_active BOOLEAN DEFAULT FALSE,
    selloff_severity NUMERIC(5,2), -- percentage price drop
    
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX idx_technical_scores_token_time ON technical_scores(token_id, calculated_at DESC);
CREATE INDEX idx_technical_scores_pool_time ON technical_scores(pool_id, calculated_at DESC);
CREATE INDEX idx_technical_scores_total ON technical_scores(total_score DESC);
CREATE INDEX idx_technical_scores_calculated_at ON technical_scores(calculated_at DESC);

-- Create hypertable for time-series technical scores
SELECT create_hypertable('technical_scores', 'calculated_at');

-- Add composite primary key including the partitioning column
ALTER TABLE technical_scores ADD PRIMARY KEY (id, calculated_at);

-- Function to calculate market cap score (0-100 points)
CREATE OR REPLACE FUNCTION calculate_market_cap_score(
    p_market_cap_usd NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    position_score NUMERIC;
    velocity_score NUMERIC := 0; -- Will be calculated separately
BEGIN
    -- Market Cap Position Score (0-60 points)
    -- Optimal range: $15k-$30k
    IF p_market_cap_usd >= 15000 AND p_market_cap_usd <= 30000 THEN
        position_score := 60;
    ELSIF p_market_cap_usd >= 10000 AND p_market_cap_usd < 15000 THEN
        position_score := 40;
    ELSIF p_market_cap_usd > 30000 AND p_market_cap_usd <= 50000 THEN
        position_score := 40;
    ELSIF p_market_cap_usd >= 5000 AND p_market_cap_usd < 10000 THEN
        position_score := 20;
    ELSIF p_market_cap_usd > 50000 AND p_market_cap_usd <= 100000 THEN
        position_score := 20;
    ELSE
        position_score := 0;
    END IF;
    
    RETURN position_score;
END;
$$ LANGUAGE plpgsql;

-- Function to calculate bonding curve score (0-83 points)
CREATE OR REPLACE FUNCTION calculate_bonding_curve_score(
    p_progress NUMERIC,
    p_velocity_per_hour NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    velocity_score NUMERIC;
    consistency_score NUMERIC := 12.5; -- Default, needs historical data
    position_score NUMERIC;
BEGIN
    -- Progress Velocity Score (0-33 points)
    -- Optimal: 0.5-2% per hour
    IF p_velocity_per_hour >= 0.5 AND p_velocity_per_hour <= 2.0 THEN
        velocity_score := 33;
    ELSIF p_velocity_per_hour >= 0.3 AND p_velocity_per_hour < 0.5 THEN
        velocity_score := 20;
    ELSIF p_velocity_per_hour > 2.0 AND p_velocity_per_hour <= 3.0 THEN
        velocity_score := 20;
    ELSIF p_velocity_per_hour > 0 THEN
        velocity_score := 10;
    ELSE
        velocity_score := 0;
    END IF;
    
    -- Progress Position Score (0-25 points)
    -- Sweet spot: 5-20% progress
    IF p_progress >= 5 AND p_progress <= 20 THEN
        position_score := 25;
    ELSIF p_progress > 20 AND p_progress <= 40 THEN
        position_score := 20;
    ELSIF p_progress > 0 AND p_progress < 5 THEN
        position_score := 15;
    ELSIF p_progress > 40 AND p_progress <= 60 THEN
        position_score := 10;
    ELSE
        position_score := 5;
    END IF;
    
    RETURN velocity_score + consistency_score + position_score;
END;
$$ LANGUAGE plpgsql;

-- Function to calculate trading health score (0-75 points)
CREATE OR REPLACE FUNCTION calculate_trading_health_score(
    p_buy_sell_ratio NUMERIC,
    p_volume_trend NUMERIC,
    p_whale_concentration NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    ratio_score NUMERIC;
    volume_score NUMERIC;
    distribution_score NUMERIC;
BEGIN
    -- Buy/Sell Ratio Score (0-30 points)
    IF p_buy_sell_ratio > 2.0 THEN
        ratio_score := 30;
    ELSIF p_buy_sell_ratio >= 1.5 THEN
        ratio_score := 20;
    ELSIF p_buy_sell_ratio >= 1.0 THEN
        ratio_score := 10;
    ELSE
        ratio_score := 0;
    END IF;
    
    -- Volume Trend Score (0-25 points)
    -- p_volume_trend is percentage increase
    IF p_volume_trend > 50 THEN
        volume_score := 25;
    ELSIF p_volume_trend > 20 THEN
        volume_score := 20;
    ELSIF p_volume_trend > 0 THEN
        volume_score := 10;
    ELSE
        volume_score := 0;
    END IF;
    
    -- Transaction Distribution Score (0-20 points)
    -- Penalize whale concentration
    IF p_whale_concentration < 0.1 THEN
        distribution_score := 20;
    ELSIF p_whale_concentration < 0.2 THEN
        distribution_score := 15;
    ELSIF p_whale_concentration < 0.3 THEN
        distribution_score := 10;
    ELSIF p_whale_concentration < 0.4 THEN
        distribution_score := 5;
    ELSE
        distribution_score := 0;
    END IF;
    
    RETURN ratio_score + volume_score + distribution_score;
END;
$$ LANGUAGE plpgsql;

-- Function to calculate sell-off response score (-40 to 75 points)
CREATE OR REPLACE FUNCTION calculate_selloff_response_score(
    p_price_drop_5min NUMERIC,
    p_recovery_strength NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    sell_pressure_score NUMERIC;
    recovery_score NUMERIC;
BEGIN
    -- Sell Pressure Score (-40 to 40 points)
    IF p_price_drop_5min IS NULL OR p_price_drop_5min <= 0 THEN
        sell_pressure_score := 40; -- No sell pressure
    ELSIF p_price_drop_5min < 10 THEN
        sell_pressure_score := 30;
    ELSIF p_price_drop_5min < 20 THEN
        sell_pressure_score := 10;
    ELSIF p_price_drop_5min < 30 THEN
        sell_pressure_score := -10;
    ELSIF p_price_drop_5min < 40 THEN
        sell_pressure_score := -25;
    ELSE
        sell_pressure_score := -40; -- Maximum penalty
    END IF;
    
    -- Recovery Strength Score (0-35 points)
    -- p_recovery_strength is buy volume response ratio
    IF p_recovery_strength > 2.0 THEN
        recovery_score := 35;
    ELSIF p_recovery_strength > 1.5 THEN
        recovery_score := 25;
    ELSIF p_recovery_strength > 1.0 THEN
        recovery_score := 15;
    ELSIF p_recovery_strength > 0.5 THEN
        recovery_score := 5;
    ELSE
        recovery_score := 0;
    END IF;
    
    RETURN sell_pressure_score + recovery_score;
END;
$$ LANGUAGE plpgsql;

-- Main function to calculate complete technical score
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
    -- Get current pool data
    SELECT 
        p.latest_price_usd * 1000000000, -- 1B token supply
        p.bonding_curve_progress
    INTO v_market_cap_usd, v_bonding_curve_progress
    FROM pools p
    WHERE p.id = p_pool_id;
    
    -- Calculate progress velocity (% per hour)
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

-- Function to save technical score snapshot
CREATE OR REPLACE FUNCTION save_technical_score(
    p_token_id UUID,
    p_pool_id UUID
) RETURNS UUID AS $$
DECLARE
    v_score_id UUID;
    v_total_score NUMERIC;
    v_market_cap_score NUMERIC;
    v_bonding_curve_score NUMERIC;
    v_trading_health_score NUMERIC;
    v_selloff_response_score NUMERIC;
    v_market_cap_usd NUMERIC;
    v_bonding_curve_progress NUMERIC;
    v_buy_sell_ratio NUMERIC;
    v_is_selloff_active BOOLEAN;
BEGIN
    -- Calculate current score
    SELECT * INTO 
        v_total_score,
        v_market_cap_score,
        v_bonding_curve_score,
        v_trading_health_score,
        v_selloff_response_score,
        v_market_cap_usd,
        v_bonding_curve_progress,
        v_buy_sell_ratio,
        v_is_selloff_active
    FROM calculate_technical_score(p_token_id, p_pool_id);
    
    -- Insert score snapshot
    INSERT INTO technical_scores (
        token_id,
        pool_id,
        total_score,
        market_cap_score,
        bonding_curve_score,
        trading_health_score,
        selloff_response_score,
        market_cap_usd,
        bonding_curve_progress,
        buy_sell_ratio,
        is_selloff_active
    ) VALUES (
        p_token_id,
        p_pool_id,
        v_total_score,
        v_market_cap_score,
        v_bonding_curve_score,
        v_trading_health_score,
        v_selloff_response_score,
        v_market_cap_usd,
        v_bonding_curve_progress,
        v_buy_sell_ratio,
        v_is_selloff_active
    ) RETURNING id INTO v_score_id;
    
    RETURN v_score_id;
END;
$$ LANGUAGE plpgsql;

-- Create view for latest technical scores
CREATE VIEW latest_technical_scores AS
WITH latest_scores AS (
    SELECT DISTINCT ON (token_id)
        ts.*,
        t.symbol,
        t.name,
        p.pool_address,
        p.platform
    FROM technical_scores ts
    JOIN tokens t ON ts.token_id = t.id
    JOIN pools p ON ts.pool_id = p.id
    ORDER BY token_id, calculated_at DESC
)
SELECT * FROM latest_scores
ORDER BY total_score DESC;

-- Add compression for older technical scores
DO $$
BEGIN
    BEGIN
        ALTER TABLE technical_scores SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'token_id',
            timescaledb.compress_orderby = 'calculated_at DESC'
        );
        PERFORM add_compression_policy('technical_scores', INTERVAL '1 day');
    EXCEPTION
        WHEN OTHERS THEN
            RAISE NOTICE 'Compression policy could not be added: %', SQLERRM;
    END;
END $$;

-- Add comments
COMMENT ON TABLE technical_scores IS 'Historical technical scoring data for pump.fun tokens';
COMMENT ON FUNCTION calculate_technical_score IS 'Calculates real-time technical score for a token (0-333 points)';
COMMENT ON FUNCTION save_technical_score IS 'Saves a snapshot of technical score for historical tracking';