-- Migration: 015_technical_scoring_system
-- Description: Complete technical scoring system with sell-off detection
-- Consolidates migrations 015, 016, and 017 into a single standard migration

-- Drop old functions if they exist
DROP FUNCTION IF EXISTS calculate_technical_score_v2(UUID, UUID);
DROP FUNCTION IF EXISTS calculate_selloff_response_score_v2(UUID);
DROP FUNCTION IF EXISTS calculate_technical_score(UUID, UUID);
DROP FUNCTION IF EXISTS calculate_selloff_response_score(UUID, NUMERIC);

-- Create table to store technical scores with history
CREATE TABLE IF NOT EXISTS technical_scores (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    pool_id UUID REFERENCES pools(id) NOT NULL,
    
    -- Overall score
    total_score NUMERIC(5,2) NOT NULL CHECK (total_score >= -60 AND total_score <= 333),
    
    -- Component scores
    market_cap_score NUMERIC(5,2) NOT NULL CHECK (market_cap_score >= 0 AND market_cap_score <= 100),
    bonding_curve_score NUMERIC(5,2) NOT NULL CHECK (bonding_curve_score >= 0 AND bonding_curve_score <= 83),
    trading_health_score NUMERIC(5,2) NOT NULL CHECK (trading_health_score >= 0 AND trading_health_score <= 75),
    selloff_response_score NUMERIC(5,2) NOT NULL CHECK (selloff_response_score >= -60 AND selloff_response_score <= 75),
    
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
    selloff_severity NUMERIC(5,2),
    price_drop_15min NUMERIC(5,2),
    price_drop_30min NUMERIC(5,2),
    price_drop_1hr NUMERIC(5,2),
    consecutive_red_candles INTEGER DEFAULT 0,
    selloff_duration_minutes INTEGER DEFAULT 0,
    
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_technical_scores_token_time ON technical_scores(token_id, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_technical_scores_pool_time ON technical_scores(pool_id, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_technical_scores_total ON technical_scores(total_score DESC);
CREATE INDEX IF NOT EXISTS idx_technical_scores_calculated_at ON technical_scores(calculated_at DESC);

-- Create hypertable if TimescaleDB is available
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        PERFORM create_hypertable('technical_scores', 'calculated_at', if_not_exists => true);
        ALTER TABLE technical_scores ADD PRIMARY KEY (id, calculated_at) IF NOT EXISTS;
    END IF;
END $$;

-- Create table to track active sell-off events
CREATE TABLE IF NOT EXISTS selloff_events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    pool_id UUID REFERENCES pools(id) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    start_price NUMERIC(20,9) NOT NULL,
    lowest_price NUMERIC(20,9),
    recovery_price NUMERIC(20,9),
    max_drop_percent NUMERIC(5,2),
    total_sell_volume NUMERIC(20,9),
    total_buy_volume NUMERIC(20,9),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_selloff_events_active ON selloff_events(pool_id, is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_selloff_events_time ON selloff_events(pool_id, start_time DESC);

-- Function to calculate market cap score (0-100 points)
CREATE OR REPLACE FUNCTION calculate_market_cap_score(
    p_market_cap_usd NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    position_score NUMERIC;
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

-- Enhanced sell-off response calculation with multiple time windows
CREATE OR REPLACE FUNCTION calculate_selloff_response_score(
    p_pool_id UUID
) RETURNS TABLE (
    score NUMERIC,
    price_drop_5min NUMERIC,
    price_drop_15min NUMERIC,
    price_drop_30min NUMERIC,
    recovery_strength NUMERIC,
    is_active_selloff BOOLEAN,
    selloff_duration INTEGER
) AS $$
DECLARE
    v_price_drop_5min NUMERIC;
    v_price_drop_15min NUMERIC;
    v_price_drop_30min NUMERIC;
    v_price_drop_1hr NUMERIC;
    v_recovery_strength NUMERIC;
    v_consecutive_red INTEGER;
    v_selloff_duration INTEGER;
    v_is_active BOOLEAN;
    v_sell_pressure_score NUMERIC;
    v_recovery_score NUMERIC;
    v_duration_penalty NUMERIC;
BEGIN
    -- Calculate price drops across multiple time windows
    WITH price_metrics AS (
        SELECT 
            time_window,
            CASE 
                WHEN first_price > 0 AND last_price > 0 THEN
                    ((first_price - last_price) / first_price) * 100
                ELSE 0
            END as price_drop
        FROM (
            SELECT 
                '5min' as time_window,
                (SELECT price_per_token FROM transactions 
                 WHERE pool_id = p_pool_id AND block_time > NOW() - INTERVAL '5 minutes'
                 ORDER BY block_time ASC LIMIT 1) as first_price,
                (SELECT price_per_token FROM transactions 
                 WHERE pool_id = p_pool_id AND block_time > NOW() - INTERVAL '5 minutes'
                 ORDER BY block_time DESC LIMIT 1) as last_price
            UNION ALL
            SELECT 
                '15min' as time_window,
                (SELECT price_per_token FROM transactions 
                 WHERE pool_id = p_pool_id AND block_time > NOW() - INTERVAL '15 minutes'
                 ORDER BY block_time ASC LIMIT 1) as first_price,
                (SELECT price_per_token FROM transactions 
                 WHERE pool_id = p_pool_id 
                 ORDER BY block_time DESC LIMIT 1) as last_price
            UNION ALL
            SELECT 
                '30min' as time_window,
                (SELECT price_per_token FROM transactions 
                 WHERE pool_id = p_pool_id AND block_time > NOW() - INTERVAL '30 minutes'
                 ORDER BY block_time ASC LIMIT 1) as first_price,
                (SELECT price_per_token FROM transactions 
                 WHERE pool_id = p_pool_id 
                 ORDER BY block_time DESC LIMIT 1) as last_price
            UNION ALL
            SELECT 
                '1hr' as time_window,
                (SELECT price_per_token FROM transactions 
                 WHERE pool_id = p_pool_id AND block_time > NOW() - INTERVAL '1 hour'
                 ORDER BY block_time ASC LIMIT 1) as first_price,
                (SELECT price_per_token FROM transactions 
                 WHERE pool_id = p_pool_id 
                 ORDER BY block_time DESC LIMIT 1) as last_price
        ) t
    )
    SELECT 
        MAX(CASE WHEN time_window = '5min' THEN price_drop ELSE 0 END),
        MAX(CASE WHEN time_window = '15min' THEN price_drop ELSE 0 END),
        MAX(CASE WHEN time_window = '30min' THEN price_drop ELSE 0 END),
        MAX(CASE WHEN time_window = '1hr' THEN price_drop ELSE 0 END)
    INTO v_price_drop_5min, v_price_drop_15min, v_price_drop_30min, v_price_drop_1hr
    FROM price_metrics;
    
    -- Count consecutive red candles
    WITH candle_colors AS (
        SELECT 
            date_trunc('minute', block_time) as minute,
            FIRST_VALUE(price_per_token) OVER (PARTITION BY date_trunc('minute', block_time) ORDER BY block_time) as open_price,
            LAST_VALUE(price_per_token) OVER (PARTITION BY date_trunc('minute', block_time) ORDER BY block_time 
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as close_price
        FROM transactions
        WHERE pool_id = p_pool_id
        AND block_time > NOW() - INTERVAL '30 minutes'
        AND price_per_token IS NOT NULL
    ),
    red_candles AS (
        SELECT 
            minute,
            CASE WHEN close_price < open_price THEN 1 ELSE 0 END as is_red,
            ROW_NUMBER() OVER (ORDER BY minute DESC) as rn
        FROM candle_colors
    )
    SELECT COUNT(*) 
    INTO v_consecutive_red
    FROM red_candles
    WHERE is_red = 1
    AND rn <= (SELECT MIN(rn) FROM red_candles WHERE is_red = 0);
    
    -- Check for active sell-off event
    SELECT 
        COALESCE(EXTRACT(EPOCH FROM (NOW() - start_time)) / 60, 0)::INTEGER
    INTO v_selloff_duration
    FROM selloff_events
    WHERE pool_id = p_pool_id
    AND is_active = TRUE
    LIMIT 1;
    
    -- Determine if sell-off is active
    v_is_active := (v_price_drop_5min > 10) OR 
                   (v_price_drop_15min > 15) OR 
                   (v_price_drop_30min > 20) OR
                   (v_consecutive_red >= 3) OR
                   (v_selloff_duration > 0);
    
    -- Calculate recovery strength
    WITH recovery_data AS (
        SELECT 
            type,
            sol_amount,
            block_time,
            CASE 
                WHEN block_time > NOW() - INTERVAL '5 minutes' THEN 1.5
                WHEN block_time > NOW() - INTERVAL '15 minutes' THEN 1.0
                ELSE 0.5
            END as time_weight
        FROM transactions
        WHERE pool_id = p_pool_id
        AND block_time > NOW() - INTERVAL '30 minutes'
    )
    SELECT 
        COALESCE(
            SUM(CASE WHEN type = 'buy' THEN sol_amount * time_weight ELSE 0 END) /
            NULLIF(SUM(CASE WHEN type = 'sell' THEN sol_amount * time_weight ELSE 0 END), 0),
            1.0
        )
    INTO v_recovery_strength
    FROM recovery_data;
    
    -- Calculate sell pressure score
    v_sell_pressure_score := CASE
        WHEN v_price_drop_5min <= 0 AND v_price_drop_15min <= 0 THEN 40
        WHEN v_price_drop_5min < 5 AND v_price_drop_15min < 10 THEN 30
        WHEN v_price_drop_5min < 10 AND v_price_drop_15min < 15 THEN 15
        WHEN v_price_drop_5min < 20 THEN GREATEST(-20, 10 - (v_price_drop_5min * 2))
        WHEN v_price_drop_5min < 30 OR v_price_drop_15min > 25 THEN -30
        ELSE -40
    END;
    
    -- Apply duration penalty
    IF v_selloff_duration > 0 THEN
        v_duration_penalty := LEAST(20, v_selloff_duration / 2);
        v_sell_pressure_score := v_sell_pressure_score - v_duration_penalty;
    END IF;
    
    -- Calculate recovery score
    v_recovery_score := CASE
        WHEN NOT v_is_active THEN 35
        WHEN v_recovery_strength > 3.0 THEN 35
        WHEN v_recovery_strength > 2.0 THEN 30
        WHEN v_recovery_strength > 1.5 THEN 20
        WHEN v_recovery_strength > 1.2 THEN 15
        WHEN v_recovery_strength > 1.0 THEN 10
        WHEN v_recovery_strength > 0.8 THEN 5
        WHEN v_recovery_strength > 0.5 THEN 2
        ELSE 0
    END;
    
    -- Bonus for stopping the bleeding
    IF v_consecutive_red = 0 AND v_is_active THEN
        v_recovery_score := v_recovery_score + 5;
    END IF;
    
    RETURN QUERY SELECT 
        GREATEST(-60, LEAST(75, v_sell_pressure_score + v_recovery_score)),
        v_price_drop_5min,
        v_price_drop_15min,
        v_price_drop_30min,
        v_recovery_strength,
        v_is_active,
        v_selloff_duration;
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
    v_market_cap_score NUMERIC;
    v_bonding_curve_score NUMERIC;
    v_trading_health_score NUMERIC;
    v_selloff_response_score NUMERIC;
    v_selloff_details RECORD;
BEGIN
    -- Get current pool data
    SELECT 
        p.latest_price_usd * 1000000000, -- 1B token supply
        p.bonding_curve_progress
    INTO v_market_cap_usd, v_bonding_curve_progress
    FROM pools p
    WHERE p.id = p_pool_id;
    
    -- Calculate progress velocity
    WITH progress_history AS (
        SELECT 
            p.bonding_curve_progress as progress,
            p.updated_at as time
        FROM pools p
        WHERE p.id = p_pool_id
        UNION ALL
        SELECT 
            ts.bonding_curve_progress as progress,
            ts.calculated_at as time
        FROM technical_scores ts
        WHERE ts.pool_id = p_pool_id
        AND ts.calculated_at > NOW() - INTERVAL '30 minutes'
        ORDER BY time DESC
        LIMIT 10
    )
    SELECT 
        CASE 
            WHEN COUNT(*) > 1 AND EXTRACT(EPOCH FROM (MAX(time) - MIN(time))) > 0 THEN
                (MAX(progress) - MIN(progress)) / 
                (EXTRACT(EPOCH FROM (MAX(time) - MIN(time))) / 3600)
            ELSE 0
        END
    INTO v_progress_velocity
    FROM progress_history;
    
    -- Enhanced buy/sell ratio with time decay
    WITH weighted_txns AS (
        SELECT 
            type,
            sol_amount,
            CASE 
                WHEN block_time > NOW() - INTERVAL '5 minutes' THEN 1.0
                WHEN block_time > NOW() - INTERVAL '15 minutes' THEN 0.7
                WHEN block_time > NOW() - INTERVAL '30 minutes' THEN 0.4
                ELSE 0.2
            END as weight
        FROM transactions
        WHERE pool_id = p_pool_id
        AND block_time > NOW() - INTERVAL '1 hour'
    )
    SELECT 
        COALESCE(
            SUM(CASE WHEN type = 'buy' THEN sol_amount * weight ELSE 0 END) / 
            NULLIF(SUM(CASE WHEN type = 'sell' THEN sol_amount * weight ELSE 0 END), 0),
            1.0
        )
    INTO v_buy_sell_ratio
    FROM weighted_txns;
    
    -- Calculate volume trend
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
    
    -- Calculate whale concentration
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
    
    -- Get sell-off response score
    SELECT * INTO v_selloff_details
    FROM calculate_selloff_response_score(p_pool_id);
    
    -- Calculate component scores
    v_market_cap_score := calculate_market_cap_score(COALESCE(v_market_cap_usd, 0));
    
    -- Add market cap velocity component
    WITH mc_velocity AS (
        SELECT 
            CASE 
                WHEN COUNT(*) > 1 THEN
                    (MAX(latest_price_usd) - MIN(latest_price_usd)) / 
                    NULLIF(MIN(latest_price_usd), 0) * 100 / 10
                ELSE 0
            END as velocity
        FROM (
            SELECT p.latest_price_usd, p.updated_at as time_stamp
            FROM pools p
            WHERE p.id = p_pool_id
            UNION ALL
            SELECT ts.market_cap_usd / 1000000000 as latest_price_usd, ts.calculated_at as time_stamp
            FROM technical_scores ts
            WHERE ts.pool_id = p_pool_id
            AND ts.calculated_at > NOW() - INTERVAL '10 minutes'
            ORDER BY time_stamp DESC
            LIMIT 5
        ) history
    )
    SELECT 
        v_market_cap_score + 
        CASE 
            WHEN velocity >= 0.5 AND velocity <= 2 THEN 40
            WHEN velocity >= 0.2 AND velocity < 0.5 THEN 25
            WHEN velocity > 2 AND velocity <= 3 THEN 25
            WHEN velocity > 0 THEN 10
            ELSE 0
        END
    INTO v_market_cap_score
    FROM mc_velocity;
    
    v_bonding_curve_score := calculate_bonding_curve_score(
        COALESCE(v_bonding_curve_progress, 0), 
        COALESCE(v_progress_velocity, 0)
    );
    
    v_trading_health_score := calculate_trading_health_score(
        COALESCE(v_buy_sell_ratio, 1), 
        COALESCE(v_volume_trend, 0), 
        COALESCE(v_whale_concentration, 0)
    );
    
    v_selloff_response_score := v_selloff_details.score;
    
    RETURN QUERY SELECT 
        v_market_cap_score + v_bonding_curve_score + v_trading_health_score + v_selloff_response_score,
        v_market_cap_score,
        v_bonding_curve_score,
        v_trading_health_score,
        v_selloff_response_score,
        v_market_cap_usd,
        v_bonding_curve_progress,
        v_buy_sell_ratio,
        v_selloff_details.is_active_selloff;
END;
$$ LANGUAGE plpgsql;

-- Function to detect and track sell-off events
CREATE OR REPLACE FUNCTION detect_selloff_event(
    p_pool_id UUID,
    p_current_price NUMERIC
) RETURNS VOID AS $$
DECLARE
    v_active_event_id UUID;
    v_start_price NUMERIC;
    v_drop_percent NUMERIC;
BEGIN
    -- Check for existing active event
    SELECT id, start_price 
    INTO v_active_event_id, v_start_price
    FROM selloff_events
    WHERE pool_id = p_pool_id AND is_active = TRUE
    LIMIT 1;
    
    IF v_active_event_id IS NOT NULL THEN
        -- Update existing event
        v_drop_percent := ((v_start_price - p_current_price) / v_start_price) * 100;
        
        UPDATE selloff_events
        SET 
            lowest_price = LEAST(lowest_price, p_current_price),
            max_drop_percent = GREATEST(max_drop_percent, v_drop_percent)
        WHERE id = v_active_event_id;
        
        -- Check if recovery threshold met
        IF p_current_price > v_start_price * 0.9 THEN
            UPDATE selloff_events
            SET 
                end_time = NOW(),
                recovery_price = p_current_price,
                is_active = FALSE
            WHERE id = v_active_event_id;
        END IF;
    ELSE
        -- Check if new sell-off should be tracked
        WITH recent_high AS (
            SELECT MAX(price_per_token) as high_price
            FROM transactions
            WHERE pool_id = p_pool_id
            AND block_time > NOW() - INTERVAL '15 minutes'
        )
        SELECT ((high_price - p_current_price) / high_price) * 100
        INTO v_drop_percent
        FROM recent_high;
        
        -- Start tracking if drop > 10%
        IF v_drop_percent > 10 THEN
            INSERT INTO selloff_events (
                pool_id,
                start_time,
                start_price,
                lowest_price,
                max_drop_percent
            ) VALUES (
                p_pool_id,
                NOW(),
                (SELECT high_price FROM recent_high),
                p_current_price,
                v_drop_percent
            );
        END IF;
    END IF;
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
CREATE OR REPLACE VIEW latest_technical_scores AS
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

-- Add comments
COMMENT ON TABLE technical_scores IS 'Historical technical scoring data for tokens';
COMMENT ON TABLE selloff_events IS 'Tracks sell-off events for pattern recognition';
COMMENT ON FUNCTION calculate_technical_score IS 'Calculates real-time technical score for a token (0-333 points)';
COMMENT ON FUNCTION calculate_selloff_response_score IS 'Enhanced sell-off detection with multi-window analysis';
COMMENT ON FUNCTION save_technical_score IS 'Saves a snapshot of technical score for historical tracking';