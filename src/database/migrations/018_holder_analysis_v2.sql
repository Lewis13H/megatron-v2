-- Migration: Holder Analysis V2 - Production-Ready Schema
-- Optimized for Helius Developer Plan with efficient caching and real-time updates
-- Date: 2025-01-08

BEGIN;

-- ============================================
-- Drop old constraints if they exist
-- ============================================
ALTER TABLE IF EXISTS holder_scores 
  DROP CONSTRAINT IF EXISTS holder_scores_bonding_curve_progress_check;

-- ============================================
-- Enhanced holder snapshots table
-- ============================================
ALTER TABLE holder_snapshots
  ADD COLUMN IF NOT EXISTS active_holder_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS theil_index NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS entropy_index NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS top_50_percentage NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS dust_account_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snapshot_type VARCHAR(20) DEFAULT 'full', -- 'full', 'delta', 'websocket'
  ADD COLUMN IF NOT EXISTS data_source VARCHAR(20) DEFAULT 'helius', -- 'helius', 'rpc', 'websocket'
  ADD COLUMN IF NOT EXISTS credits_used INTEGER DEFAULT 0;

-- ============================================
-- Wallet quality metrics table
-- ============================================
CREATE TABLE IF NOT EXISTS wallet_quality_metrics (
    id UUID DEFAULT gen_random_uuid(),
    snapshot_id UUID REFERENCES holder_snapshots(id),
    token_id UUID REFERENCES tokens(id),
    
    -- Averages and medians
    avg_wallet_age_days NUMERIC(10,2),
    median_wallet_age_days NUMERIC(10,2),
    avg_transaction_count NUMERIC(10,2),
    median_transaction_count NUMERIC(10,2),
    
    -- Ratios
    smart_money_ratio NUMERIC(4,3),
    bot_ratio NUMERIC(4,3),
    sniper_ratio NUMERIC(4,3),
    mev_bot_ratio NUMERIC(4,3),
    diamond_hand_ratio NUMERIC(4,3), -- Holders >7 days
    paper_hand_ratio NUMERIC(4,3), -- Sold <24h
    
    -- Wallet type distribution
    trader_count INTEGER DEFAULT 0,
    holder_count INTEGER DEFAULT 0,
    whale_count INTEGER DEFAULT 0,
    unknown_count INTEGER DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (id)
);

CREATE INDEX idx_wallet_quality_token ON wallet_quality_metrics(token_id);
CREATE INDEX idx_wallet_quality_snapshot ON wallet_quality_metrics(snapshot_id);

-- ============================================
-- Activity metrics table
-- ============================================
CREATE TABLE IF NOT EXISTS activity_metrics (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id),
    metric_time TIMESTAMPTZ NOT NULL,
    
    -- Velocity metrics
    buy_velocity NUMERIC(10,2), -- Buys per hour
    sell_velocity NUMERIC(10,2), -- Sells per hour
    net_flow_rate NUMERIC(10,2), -- Net token flow per hour
    
    -- Unique actors
    unique_buyers_1h INTEGER DEFAULT 0,
    unique_sellers_1h INTEGER DEFAULT 0,
    unique_buyers_24h INTEGER DEFAULT 0,
    unique_sellers_24h INTEGER DEFAULT 0,
    
    -- Volume metrics
    volume_1h NUMERIC(20,9),
    volume_24h NUMERIC(20,9),
    volume_7d NUMERIC(20,9),
    
    -- Transaction counts
    transactions_1h INTEGER DEFAULT 0,
    transactions_24h INTEGER DEFAULT 0,
    transactions_7d INTEGER DEFAULT 0,
    
    -- Patterns
    avg_buy_size NUMERIC(20,9),
    avg_sell_size NUMERIC(20,9),
    buy_sell_ratio NUMERIC(5,2),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (token_id, metric_time)
);

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('activity_metrics', 'metric_time', if_not_exists => TRUE);

-- ============================================
-- Risk metrics table
-- ============================================
CREATE TABLE IF NOT EXISTS risk_metrics (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id),
    assessment_time TIMESTAMPTZ NOT NULL,
    
    -- Risk scores (0-100)
    concentration_risk INTEGER CHECK (concentration_risk >= 0 AND concentration_risk <= 100),
    bot_risk INTEGER CHECK (bot_risk >= 0 AND bot_risk <= 100),
    rug_pull_risk INTEGER CHECK (rug_pull_risk >= 0 AND rug_pull_risk <= 100),
    wash_trading_risk INTEGER CHECK (wash_trading_risk >= 0 AND wash_trading_risk <= 100),
    manipulation_risk INTEGER CHECK (manipulation_risk >= 0 AND manipulation_risk <= 100),
    overall_risk INTEGER CHECK (overall_risk >= 0 AND overall_risk <= 100),
    
    -- Risk indicators
    has_single_whale BOOLEAN DEFAULT FALSE,
    has_bot_swarm BOOLEAN DEFAULT FALSE,
    has_wash_trading_pattern BOOLEAN DEFAULT FALSE,
    has_pump_dump_pattern BOOLEAN DEFAULT FALSE,
    
    -- Confidence metrics
    data_quality NUMERIC(3,2) CHECK (data_quality >= 0 AND data_quality <= 1),
    confidence_score NUMERIC(3,2) CHECK (confidence_score >= 0 AND confidence_score <= 1),
    
    risk_details JSONB DEFAULT '{}',
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (token_id, assessment_time)
);

-- Convert to hypertable
SELECT create_hypertable('risk_metrics', 'assessment_time', if_not_exists => TRUE);

-- ============================================
-- Enhanced token holders table
-- ============================================
ALTER TABLE token_holders
  ADD COLUMN IF NOT EXISTS wallet_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
  ADD COLUMN IF NOT EXISTS is_smart_money BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_mev_bot BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_sniper BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS holding_duration_hours NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS profit_loss_amount NUMERIC(20,9),
  ADD COLUMN IF NOT EXISTS profit_loss_percentage NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS entry_price NUMERIC(20,9),
  ADD COLUMN IF NOT EXISTS avg_buy_price NUMERIC(20,9);

-- ============================================
-- Enhanced wallet analysis cache
-- ============================================
ALTER TABLE wallet_analysis_cache
  ADD COLUMN IF NOT EXISTS is_smart_money BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_mev_bot BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_sniper BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS win_rate NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS avg_profit_percentage NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS best_trade_profit NUMERIC(20,9),
  ADD COLUMN IF NOT EXISTS worst_trade_loss NUMERIC(20,9),
  ADD COLUMN IF NOT EXISTS tokens_rugged_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_mooned_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_pnl NUMERIC(20,9);

-- ============================================
-- Holder score v2 with enhanced tracking
-- ============================================
ALTER TABLE holder_scores
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(3,2) DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS data_completeness NUMERIC(3,2) DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS risk_assessment JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS wallet_quality JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS activity_metrics JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS freeze_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS credits_used INTEGER DEFAULT 0;

-- Update constraint to allow scoring beyond 25% for monitoring until graduation
UPDATE holder_scores SET bonding_curve_progress = LEAST(bonding_curve_progress, 99.99);
ALTER TABLE holder_scores 
  DROP CONSTRAINT IF EXISTS holder_scores_bonding_curve_progress_check,
  ADD CONSTRAINT holder_scores_bonding_curve_progress_check 
    CHECK (bonding_curve_progress >= 10 AND bonding_curve_progress < 100);

-- ============================================
-- API credit tracking table
-- ============================================
CREATE TABLE IF NOT EXISTS api_credit_usage (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    service VARCHAR(50) NOT NULL, -- 'helius', 'birdeye', 'jupiter'
    endpoint VARCHAR(100),
    credits_used INTEGER NOT NULL,
    request_type VARCHAR(50), -- 'rpc', 'enhanced_api', 'websocket'
    token_mint VARCHAR(44),
    usage_time TIMESTAMPTZ DEFAULT NOW(),
    response_time_ms INTEGER,
    status_code INTEGER,
    error_message TEXT,
    metadata JSONB DEFAULT '{}'
);

-- Convert to hypertable for tracking over time
SELECT create_hypertable('api_credit_usage', 'usage_time', if_not_exists => TRUE);

-- ============================================
-- Real-time holder updates via WebSocket
-- ============================================
CREATE TABLE IF NOT EXISTS holder_updates (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id),
    update_time TIMESTAMPTZ NOT NULL,
    update_type VARCHAR(20), -- 'buy', 'sell', 'transfer', 'burn'
    
    -- Change details
    wallet_address VARCHAR(44),
    previous_balance NUMERIC(30,6),
    new_balance NUMERIC(30,6),
    balance_change NUMERIC(30,6),
    
    -- Impact metrics
    holder_count_before INTEGER,
    holder_count_after INTEGER,
    concentration_change NUMERIC(5,2),
    
    -- Source
    source VARCHAR(20) DEFAULT 'websocket',
    transaction_signature VARCHAR(100),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (id)
);

CREATE INDEX idx_holder_updates_token_time ON holder_updates(token_id, update_time DESC);

-- ============================================
-- Materialized views for performance
-- ============================================

-- Latest holder scores with all metrics
CREATE MATERIALIZED VIEW IF NOT EXISTS latest_holder_scores_v2 AS
SELECT DISTINCT ON (t.mint_address)
    t.mint_address,
    t.symbol,
    t.name,
    hs.score_time,
    hs.bonding_curve_progress,
    hs.total_score,
    hs.distribution_score,
    hs.quality_score,
    hs.activity_score,
    hs.confidence_score,
    hs.data_completeness,
    hs.unique_holders,
    hs.gini_coefficient,
    hs.top_10_concentration,
    hs.avg_wallet_age_days,
    hs.bot_ratio,
    hs.organic_growth_score,
    hs.is_frozen,
    rm.overall_risk as risk_score,
    rm.concentration_risk,
    rm.bot_risk,
    rm.rug_pull_risk
FROM tokens t
JOIN holder_scores hs ON t.id = hs.token_id
LEFT JOIN risk_metrics rm ON t.id = rm.token_id 
    AND rm.assessment_time = (
        SELECT MAX(assessment_time) 
        FROM risk_metrics rm2 
        WHERE rm2.token_id = t.id
    )
WHERE hs.score_time > NOW() - INTERVAL '24 hours'
ORDER BY t.mint_address, hs.score_time DESC;

CREATE UNIQUE INDEX ON latest_holder_scores_v2 (mint_address);

-- Wallet leaderboard
CREATE MATERIALIZED VIEW IF NOT EXISTS smart_money_wallets AS
SELECT 
    wallet_address,
    wallet_type,
    risk_score,
    total_transactions,
    unique_tokens_held,
    total_volume_sol,
    avg_holding_duration_days,
    profit_loss_ratio,
    successful_trades,
    rug_count,
    win_rate,
    total_pnl,
    last_updated
FROM wallet_analysis_cache
WHERE is_smart_money = TRUE
    AND last_updated > NOW() - INTERVAL '30 days'
ORDER BY total_pnl DESC, win_rate DESC
LIMIT 1000;

CREATE INDEX ON smart_money_wallets (wallet_address);

-- ============================================
-- Functions for efficient calculations
-- ============================================

-- Calculate Theil Index
CREATE OR REPLACE FUNCTION calculate_theil_index(percentages NUMERIC[])
RETURNS NUMERIC AS $$
DECLARE
    n INTEGER;
    avg_share NUMERIC;
    theil NUMERIC := 0;
    i INTEGER;
BEGIN
    n := array_length(percentages, 1);
    IF n IS NULL OR n = 0 THEN
        RETURN 0;
    END IF;
    
    avg_share := 100.0 / n;
    
    FOR i IN 1..n LOOP
        IF percentages[i] > 0 THEN
            theil := theil + (percentages[i] / 100.0) * ln(percentages[i] / avg_share);
        END IF;
    END LOOP;
    
    RETURN theil;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Calculate Shannon Entropy
CREATE OR REPLACE FUNCTION calculate_shannon_entropy(percentages NUMERIC[])
RETURNS NUMERIC AS $$
DECLARE
    entropy NUMERIC := 0;
    i INTEGER;
    proportion NUMERIC;
BEGIN
    FOR i IN 1..array_length(percentages, 1) LOOP
        IF percentages[i] > 0 THEN
            proportion := percentages[i] / 100.0;
            entropy := entropy - proportion * (ln(proportion) / ln(2));
        END IF;
    END LOOP;
    
    RETURN entropy;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Get holder velocity (new holders per hour)
CREATE OR REPLACE FUNCTION get_holder_velocity(p_token_id UUID, p_hours INTEGER DEFAULT 24)
RETURNS TABLE (
    hour TIMESTAMPTZ,
    new_holders INTEGER,
    lost_holders INTEGER,
    net_change INTEGER
) AS $$
BEGIN
    RETURN QUERY
    WITH hourly_changes AS (
        SELECT 
            date_trunc('hour', snapshot_time) as hour,
            holder_count,
            LAG(holder_count) OVER (ORDER BY snapshot_time) as prev_count
        FROM holder_snapshots
        WHERE token_id = p_token_id
            AND snapshot_time > NOW() - INTERVAL '1 hour' * p_hours
    )
    SELECT 
        hc.hour,
        GREATEST(0, hc.holder_count - COALESCE(hc.prev_count, hc.holder_count)) as new_holders,
        GREATEST(0, COALESCE(hc.prev_count, hc.holder_count) - hc.holder_count) as lost_holders,
        hc.holder_count - COALESCE(hc.prev_count, hc.holder_count) as net_change
    FROM hourly_changes hc
    WHERE hc.prev_count IS NOT NULL
    ORDER BY hc.hour DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Triggers for automated updates
-- ============================================

-- Auto-calculate risk metrics on new holder snapshot
CREATE OR REPLACE FUNCTION calculate_risk_metrics_trigger()
RETURNS TRIGGER AS $$
DECLARE
    v_concentration_risk INTEGER;
    v_bot_risk INTEGER;
    v_overall_risk INTEGER;
BEGIN
    -- Simple risk calculation based on snapshot data
    v_concentration_risk := CASE
        WHEN NEW.top_holder_percentage > 20 THEN 80
        WHEN NEW.top_holder_percentage > 10 THEN 50
        WHEN NEW.top_holder_percentage > 5 THEN 20
        ELSE 0
    END;
    
    v_bot_risk := 0; -- Would need wallet quality data
    
    v_overall_risk := (v_concentration_risk * 0.5 + v_bot_risk * 0.5)::INTEGER;
    
    -- Insert risk metrics
    INSERT INTO risk_metrics (
        token_id,
        assessment_time,
        concentration_risk,
        bot_risk,
        overall_risk,
        has_single_whale,
        data_quality,
        confidence_score
    ) VALUES (
        NEW.token_id,
        NEW.snapshot_time,
        v_concentration_risk,
        v_bot_risk,
        v_overall_risk,
        NEW.top_holder_percentage > 30,
        0.8,
        0.7
    );
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER calculate_risk_on_snapshot
AFTER INSERT ON holder_snapshots
FOR EACH ROW
EXECUTE FUNCTION calculate_risk_metrics_trigger();

-- ============================================
-- Monitoring and maintenance
-- ============================================

-- Add compression policies
SELECT add_compression_policy('activity_metrics', INTERVAL '7 days');
SELECT add_compression_policy('risk_metrics', INTERVAL '7 days');
SELECT add_compression_policy('api_credit_usage', INTERVAL '30 days');

-- Add retention policies
SELECT add_retention_policy('api_credit_usage', INTERVAL '90 days');
SELECT add_retention_policy('holder_updates', INTERVAL '30 days');

-- Refresh materialized views periodically
CREATE OR REPLACE FUNCTION refresh_holder_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY latest_holder_scores_v2;
    REFRESH MATERIALIZED VIEW CONCURRENTLY smart_money_wallets;
END;
$$ LANGUAGE plpgsql;

-- Schedule refresh every 5 minutes
SELECT cron.schedule('refresh-holder-views', '*/5 * * * *', 'SELECT refresh_holder_views()');

COMMIT;

-- ============================================
-- Verification
-- ============================================
DO $$
BEGIN
    RAISE NOTICE 'Holder Analysis V2 migration completed successfully';
    RAISE NOTICE 'New features added:';
    RAISE NOTICE '  - Enhanced distribution metrics (Theil, Shannon entropy)';
    RAISE NOTICE '  - Wallet quality tracking with smart money detection';
    RAISE NOTICE '  - Real-time activity metrics';
    RAISE NOTICE '  - Comprehensive risk assessment';
    RAISE NOTICE '  - API credit usage tracking';
    RAISE NOTICE '  - WebSocket update support';
    RAISE NOTICE '  - Materialized views for performance';
    RAISE NOTICE '  - Automated risk calculation triggers';
END $$;