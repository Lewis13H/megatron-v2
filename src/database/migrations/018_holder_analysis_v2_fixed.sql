-- Migration: 018_holder_analysis_v2_fixed
-- Description: Complete holder analysis system with enhanced metrics and API tracking
-- Optimized for 50-75% usage of 10M monthly Helius credits
-- Fixed version that handles TimescaleDB issues

-- Drop old tables if they exist (clean slate for v2)
DROP TABLE IF EXISTS holder_scores CASCADE;
DROP TABLE IF EXISTS holder_snapshots CASCADE;
DROP TABLE IF EXISTS wallet_analysis CASCADE;
DROP TABLE IF EXISTS token_holders CASCADE;
DROP TABLE IF EXISTS wallet_analysis_cache CASCADE;
DROP TABLE IF EXISTS holder_snapshots_v2 CASCADE;
DROP TABLE IF EXISTS wallet_analysis_v2 CASCADE;
DROP TABLE IF EXISTS holder_scores_v2 CASCADE;
DROP TABLE IF EXISTS helius_api_usage CASCADE;
DROP TABLE IF EXISTS holder_analysis_queue CASCADE;
DROP MATERIALIZED VIEW IF EXISTS holder_analysis_summary CASCADE;
DROP MATERIALIZED VIEW IF EXISTS holder_metrics_hourly CASCADE;

-- Enhanced holder snapshots with comprehensive metrics
CREATE TABLE IF NOT EXISTS holder_snapshots_v2 (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Distribution Metrics (more comprehensive)
    unique_holders INT NOT NULL,
    gini_coefficient DECIMAL(5,4) NOT NULL CHECK (gini_coefficient BETWEEN 0 AND 1),
    herfindahl_index DECIMAL(7,2) NOT NULL CHECK (herfindahl_index BETWEEN 0 AND 10000),
    theil_index DECIMAL(5,4),
    shannon_entropy DECIMAL(5,4),
    top_1_percent DECIMAL(5,2) NOT NULL CHECK (top_1_percent BETWEEN 0 AND 100),
    top_10_percent DECIMAL(5,2) NOT NULL CHECK (top_10_percent BETWEEN 0 AND 100),
    top_100_holders DECIMAL(5,2) NOT NULL CHECK (top_100_holders BETWEEN 0 AND 100),
    median_balance DECIMAL(20,6),
    average_balance DECIMAL(20,6),
    standard_deviation DECIMAL(20,6),
    coefficient_of_variation DECIMAL(10,4),
    
    -- Quality Metrics (enhanced)
    bot_count INT NOT NULL DEFAULT 0,
    bot_ratio DECIMAL(5,4) NOT NULL DEFAULT 0 CHECK (bot_ratio BETWEEN 0 AND 1),
    smart_money_count INT DEFAULT 0,
    smart_money_ratio DECIMAL(5,4) DEFAULT 0 CHECK (smart_money_ratio BETWEEN 0 AND 1),
    diamond_hands_count INT DEFAULT 0,
    diamond_hands_ratio DECIMAL(5,4) DEFAULT 0 CHECK (diamond_hands_ratio BETWEEN 0 AND 1),
    whale_count INT DEFAULT 0,
    avg_wallet_age_days DECIMAL(10,2),
    median_wallet_age_days DECIMAL(10,2),
    verified_wallets INT DEFAULT 0,
    high_risk_wallets INT DEFAULT 0,
    avg_risk_score DECIMAL(5,2) CHECK (avg_risk_score BETWEEN 0 AND 100),
    
    -- Activity Metrics (expanded)
    active_holders_1h INT DEFAULT 0,
    active_holders_24h INT DEFAULT 0,
    new_holders_24h INT DEFAULT 0,
    buyers_count INT DEFAULT 0,
    sellers_count INT DEFAULT 0,
    buyer_seller_ratio DECIMAL(10,4),
    avg_transaction_count DECIMAL(10,2),
    velocity_score DECIMAL(5,4) CHECK (velocity_score BETWEEN 0 AND 1),
    organic_growth_score DECIMAL(5,4) CHECK (organic_growth_score BETWEEN 0 AND 1),
    trading_intensity DECIMAL(5,4) CHECK (trading_intensity BETWEEN 0 AND 1),
    
    -- Risk Metrics (comprehensive)
    concentration_risk DECIMAL(5,2) CHECK (concentration_risk BETWEEN 0 AND 100),
    bot_risk DECIMAL(5,2) CHECK (bot_risk BETWEEN 0 AND 100),
    rug_risk DECIMAL(5,2) CHECK (rug_risk BETWEEN 0 AND 100),
    wash_trading_risk DECIMAL(5,2) CHECK (wash_trading_risk BETWEEN 0 AND 100),
    liquidity_risk DECIMAL(5,2) CHECK (liquidity_risk BETWEEN 0 AND 100),
    volatility_risk DECIMAL(5,2) CHECK (volatility_risk BETWEEN 0 AND 100),
    overall_risk DECIMAL(5,2) CHECK (overall_risk BETWEEN 0 AND 100),
    
    -- API Usage Tracking
    api_credits_used INT DEFAULT 0,
    cache_hit_rate DECIMAL(5,4),
    processing_time_ms INT,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    analysis_version TEXT DEFAULT 'v2.0',
    
    -- Add composite primary key for TimescaleDB
    PRIMARY KEY (id, snapshot_time)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_token_time ON holder_snapshots_v2(token_id, snapshot_time DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_risk ON holder_snapshots_v2(overall_risk DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_smart_money ON holder_snapshots_v2(smart_money_ratio DESC) WHERE smart_money_ratio > 0;
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_bots ON holder_snapshots_v2(bot_ratio DESC) WHERE bot_ratio > 0.3;

-- Convert to TimescaleDB hypertable if available
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        -- Check if already a hypertable
        IF NOT EXISTS (
            SELECT 1 FROM timescaledb_information.hypertables 
            WHERE hypertable_name = 'holder_snapshots_v2'
        ) THEN
            PERFORM create_hypertable('holder_snapshots_v2', 'snapshot_time', if_not_exists => true);
        END IF;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'TimescaleDB hypertable creation skipped: %', SQLERRM;
END $$;

-- Enhanced wallet analysis cache with pattern detection
CREATE TABLE IF NOT EXISTS wallet_analysis_v2 (
    wallet_address VARCHAR(44) PRIMARY KEY,
    
    -- Wallet basics
    created_at TIMESTAMPTZ,
    last_active TIMESTAMPTZ,
    last_analyzed TIMESTAMPTZ DEFAULT NOW(),
    analysis_count INT DEFAULT 1,
    
    -- Transaction metrics
    transaction_count INT DEFAULT 0,
    buy_count INT DEFAULT 0,
    sell_count INT DEFAULT 0,
    unique_tokens_traded INT DEFAULT 0,
    
    -- Financial metrics
    total_volume_usd DECIMAL(20,2),
    total_pnl_usd DECIMAL(20,2),
    win_rate DECIMAL(5,4) CHECK (win_rate IS NULL OR (win_rate BETWEEN 0 AND 1)),
    avg_hold_time_hours DECIMAL(10,2),
    graduated_tokens INT DEFAULT 0,
    rug_pull_exposure INT DEFAULT 0,
    
    -- Current state
    sol_balance DECIMAL(20,9),
    wallet_age_days INT,
    
    -- Pattern detection
    is_bot BOOLEAN DEFAULT FALSE,
    is_smart_money BOOLEAN DEFAULT FALSE,
    is_mev_bot BOOLEAN DEFAULT FALSE,
    is_sniper_bot BOOLEAN DEFAULT FALSE,
    is_diamond_hands BOOLEAN DEFAULT FALSE,
    is_paper_hands BOOLEAN DEFAULT FALSE,
    
    -- Risk assessment
    risk_score INT CHECK (risk_score IS NULL OR (risk_score BETWEEN 0 AND 100)),
    pump_dump_risk INT CHECK (pump_dump_risk IS NULL OR (pump_dump_risk BETWEEN 0 AND 100)),
    
    -- Behavioral patterns
    avg_buy_size_sol DECIMAL(20,9),
    avg_sell_size_sol DECIMAL(20,9),
    trade_frequency_per_day DECIMAL(10,4),
    profit_taking_pattern VARCHAR(50), -- 'quick', 'gradual', 'holder', 'mixed'
    
    -- Network analysis
    connected_wallets_count INT DEFAULT 0,
    cluster_id UUID,
    
    -- Performance tracking
    cache_hits INT DEFAULT 0,
    cache_misses INT DEFAULT 0
);

-- Create indexes for wallet analysis
CREATE INDEX IF NOT EXISTS idx_wallet_v2_smart_money ON wallet_analysis_v2(is_smart_money) WHERE is_smart_money = TRUE;
CREATE INDEX IF NOT EXISTS idx_wallet_v2_bot ON wallet_analysis_v2(is_bot) WHERE is_bot = TRUE;
CREATE INDEX IF NOT EXISTS idx_wallet_v2_last_analyzed ON wallet_analysis_v2(last_analyzed DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_v2_risk ON wallet_analysis_v2(risk_score DESC) WHERE risk_score > 50;
CREATE INDEX IF NOT EXISTS idx_wallet_v2_cluster ON wallet_analysis_v2(cluster_id) WHERE cluster_id IS NOT NULL;

-- Holder scores with comprehensive breakdown
CREATE TABLE IF NOT EXISTS holder_scores_v2 (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    score_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Main scores (333 total)
    total_score DECIMAL(5,1) NOT NULL CHECK (total_score BETWEEN 0 AND 333),
    distribution_score DECIMAL(5,1) CHECK (distribution_score BETWEEN 0 AND 111),
    quality_score DECIMAL(5,1) CHECK (quality_score BETWEEN 0 AND 111),
    activity_score DECIMAL(5,1) CHECK (activity_score BETWEEN 0 AND 111),
    
    -- Score components breakdown
    gini_points DECIMAL(4,1),
    concentration_points DECIMAL(4,1),
    holder_count_points DECIMAL(4,1),
    bot_penalty DECIMAL(4,1),
    smart_money_bonus DECIMAL(4,1),
    wallet_age_points DECIMAL(4,1),
    activity_points DECIMAL(4,1),
    organic_growth_points DECIMAL(4,1),
    velocity_points DECIMAL(4,1),
    
    -- Key metrics snapshot
    bonding_curve_progress DECIMAL(5,2),
    unique_holders INT,
    gini_coefficient DECIMAL(5,4),
    bot_ratio DECIMAL(5,4),
    smart_money_ratio DECIMAL(5,4),
    overall_risk DECIMAL(5,2),
    
    -- Alerts and recommendations
    alerts JSONB,
    recommendations JSONB,
    
    -- Scoring metadata
    scoring_version VARCHAR(10) DEFAULT 'v2.0',
    is_frozen BOOLEAN DEFAULT FALSE,
    
    PRIMARY KEY (id, score_time)
);

-- Create indexes for holder scores
CREATE INDEX IF NOT EXISTS idx_scores_v2_token_time ON holder_scores_v2(token_id, score_time DESC);
CREATE INDEX IF NOT EXISTS idx_scores_v2_total ON holder_scores_v2(total_score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_v2_frozen ON holder_scores_v2(is_frozen) WHERE is_frozen = TRUE;

-- API credit usage tracking (essential for optimization)
CREATE TABLE IF NOT EXISTS helius_api_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    endpoint VARCHAR(100) NOT NULL,
    credits_used INT NOT NULL,
    token_id UUID REFERENCES tokens(id),
    success_count INT DEFAULT 1,
    error_count INT DEFAULT 0,
    avg_response_time_ms INT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(date, endpoint)
);

-- Create indexes for API usage
CREATE INDEX IF NOT EXISTS idx_api_usage_date ON helius_api_usage(date DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_endpoint ON helius_api_usage(endpoint);
CREATE INDEX IF NOT EXISTS idx_api_usage_token ON helius_api_usage(token_id) WHERE token_id IS NOT NULL;

-- Analysis queue for batch processing
CREATE TABLE IF NOT EXISTS holder_analysis_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    mint_address VARCHAR(44) NOT NULL,
    bonding_curve_progress DECIMAL(5,2),
    priority INT DEFAULT 50, -- 0-100, higher = more urgent
    status VARCHAR(20) DEFAULT 'pending', -- pending, processing, completed, failed
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    scheduled_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    api_credits_estimated INT,
    api_credits_used INT,
    
    CONSTRAINT status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

-- Create indexes for queue
CREATE INDEX IF NOT EXISTS idx_queue_status_priority ON holder_analysis_queue(status, priority DESC) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_queue_scheduled ON holder_analysis_queue(scheduled_at) WHERE status = 'pending';

-- Create materialized view for dashboard (refreshed every 5 minutes)
CREATE MATERIALIZED VIEW IF NOT EXISTS holder_analysis_summary AS
SELECT 
    t.symbol,
    t.name,
    t.mint_address,
    hs.token_id,
    hs.snapshot_time,
    hs.unique_holders,
    hs.gini_coefficient,
    hs.bot_ratio,
    hs.smart_money_ratio,
    hs.diamond_hands_ratio,
    hs.overall_risk,
    hs.api_credits_used,
    s.total_score,
    s.distribution_score,
    s.quality_score,
    s.activity_score,
    s.alerts,
    p.bonding_curve_progress,
    p.latest_price_usd
FROM holder_snapshots_v2 hs
JOIN tokens t ON hs.token_id = t.id
LEFT JOIN pools p ON t.id = p.token_id
LEFT JOIN LATERAL (
    SELECT * FROM holder_scores_v2 
    WHERE token_id = hs.token_id 
    ORDER BY score_time DESC 
    LIMIT 1
) s ON TRUE
WHERE hs.snapshot_time > NOW() - INTERVAL '24 hours'
ORDER BY hs.snapshot_time DESC;

-- Create indexes on materialized view
CREATE INDEX IF NOT EXISTS idx_summary_time ON holder_analysis_summary(snapshot_time DESC);
CREATE INDEX IF NOT EXISTS idx_summary_score ON holder_analysis_summary(total_score DESC) WHERE total_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_summary_risk ON holder_analysis_summary(overall_risk DESC);

-- Function to get optimal tokens for analysis
CREATE OR REPLACE FUNCTION get_tokens_for_holder_analysis(
    p_limit INT DEFAULT 10
) RETURNS TABLE (
    token_id UUID,
    mint_address VARCHAR(44),
    symbol VARCHAR(10),
    bonding_curve_progress DECIMAL(5,2),
    last_analyzed TIMESTAMPTZ,
    hours_since_analysis DECIMAL(10,2),
    priority_score INT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        t.id as token_id,
        t.mint_address,
        t.symbol,
        p.bonding_curve_progress,
        MAX(hs.snapshot_time) as last_analyzed,
        EXTRACT(EPOCH FROM (NOW() - MAX(hs.snapshot_time))) / 3600 as hours_since_analysis,
        CASE 
            -- High priority for sweet spot (10-50% progress)
            WHEN p.bonding_curve_progress BETWEEN 10 AND 50 THEN 
                100 - LEAST(50, COALESCE(EXTRACT(EPOCH FROM (NOW() - MAX(hs.snapshot_time))) / 3600, 100))
            -- Medium priority for 5-10% or 50-70%
            WHEN p.bonding_curve_progress BETWEEN 5 AND 10 
                OR p.bonding_curve_progress BETWEEN 50 AND 70 THEN
                70 - LEAST(30, COALESCE(EXTRACT(EPOCH FROM (NOW() - MAX(hs.snapshot_time))) / 3600, 100))
            -- Low priority for others
            ELSE 
                30 - LEAST(20, COALESCE(EXTRACT(EPOCH FROM (NOW() - MAX(hs.snapshot_time))) / 3600, 100))
        END::INT as priority_score
    FROM tokens t
    JOIN pools p ON t.id = p.token_id
    LEFT JOIN holder_snapshots_v2 hs ON t.id = hs.token_id
    WHERE 
        t.platform = 'pumpfun'
        AND p.status = 'active'
        AND p.bonding_curve_progress BETWEEN 5 AND 70
        AND (
            hs.snapshot_time IS NULL 
            OR hs.snapshot_time < NOW() - INTERVAL '1 hour'
        )
    GROUP BY t.id, t.mint_address, t.symbol, p.bonding_curve_progress
    ORDER BY priority_score DESC, hours_since_analysis DESC NULLS FIRST
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to estimate API credits needed
CREATE OR REPLACE FUNCTION estimate_analysis_credits(
    p_holder_count INT,
    p_cache_hit_rate DECIMAL DEFAULT 0.7
) RETURNS INT AS $$
DECLARE
    v_holder_fetch_credits INT;
    v_enrichment_credits INT;
BEGIN
    -- 1 credit per 1000 holders for fetching
    v_holder_fetch_credits := CEIL(p_holder_count::DECIMAL / 1000);
    
    -- 2 credits per uncached wallet
    v_enrichment_credits := FLOOR(p_holder_count * (1 - p_cache_hit_rate)) * 2;
    
    RETURN v_holder_fetch_credits + v_enrichment_credits;
END;
$$ LANGUAGE plpgsql;

-- Add comments for documentation
COMMENT ON TABLE holder_snapshots_v2 IS 'Comprehensive holder analysis snapshots with distribution, quality, and risk metrics';
COMMENT ON TABLE wallet_analysis_v2 IS 'Cached wallet analysis data with pattern detection and risk assessment';
COMMENT ON TABLE holder_scores_v2 IS 'Calculated holder scores (333 point system) with component breakdown';
COMMENT ON TABLE helius_api_usage IS 'Tracks API credit usage for optimization and monitoring';
COMMENT ON TABLE holder_analysis_queue IS 'Queue for batch processing holder analysis jobs';
COMMENT ON MATERIALIZED VIEW holder_analysis_summary IS 'Dashboard view refreshed every 5 minutes';
COMMENT ON FUNCTION get_tokens_for_holder_analysis IS 'Returns prioritized list of tokens for holder analysis';
COMMENT ON FUNCTION estimate_analysis_credits IS 'Estimates Helius API credits needed for token analysis';

-- Grant permissions (adjust as needed)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO PUBLIC;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;

-- Initial data to track usage
INSERT INTO helius_api_usage (date, endpoint, credits_used)
VALUES (CURRENT_DATE, 'initial', 0)
ON CONFLICT DO NOTHING;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Holder Analysis V2 migration completed successfully!';
    RAISE NOTICE 'Tables created: holder_snapshots_v2, wallet_analysis_v2, holder_scores_v2, helius_api_usage, holder_analysis_queue';
    RAISE NOTICE 'Functions created: get_tokens_for_holder_analysis, estimate_analysis_credits';
    RAISE NOTICE 'Materialized view created: holder_analysis_summary';
END $$;