-- Migration: Create holder tracking tables for token distribution analysis
-- Description: Adds tables for tracking token holders, distribution snapshots, and holder scores
-- Required for: Holder Score calculation (10-25% bonding curve activation)

BEGIN;

-- 1. Holder snapshots table for tracking distribution over time
CREATE TABLE IF NOT EXISTS holder_snapshots (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    snapshot_time TIMESTAMPTZ NOT NULL,
    bonding_curve_progress NUMERIC(5,2),
    holder_count INTEGER NOT NULL,
    
    -- Distribution metrics
    top_holder_percentage NUMERIC(5,2),
    top_5_percentage NUMERIC(5,2),
    top_10_percentage NUMERIC(5,2),
    top_20_percentage NUMERIC(5,2),
    gini_coefficient NUMERIC(4,3),
    hhi_index NUMERIC(10,2), -- Herfindahl-Hirschman Index
    
    -- Balance statistics
    average_balance NUMERIC(30,6),
    median_balance NUMERIC(30,6),
    std_deviation NUMERIC(30,6),
    
    -- Holder categories
    whales_count INTEGER DEFAULT 0, -- >5% holdings
    large_holders_count INTEGER DEFAULT 0, -- 1-5% holdings
    medium_holders_count INTEGER DEFAULT 0, -- 0.1-1% holdings
    small_holders_count INTEGER DEFAULT 0, -- <0.1% holdings
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (token_id, snapshot_time)
);

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('holder_snapshots', 'snapshot_time', if_not_exists => TRUE);

-- 2. Individual token holders tracking
CREATE TABLE IF NOT EXISTS token_holders (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    wallet_address VARCHAR(44) NOT NULL,
    
    -- Balance tracking
    balance NUMERIC(30,6) NOT NULL,
    balance_percentage NUMERIC(5,2), -- % of total supply
    
    -- Temporal data
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    last_transaction TIMESTAMPTZ,
    
    -- Activity metrics
    transaction_count INTEGER DEFAULT 0,
    buy_count INTEGER DEFAULT 0,
    sell_count INTEGER DEFAULT 0,
    
    -- Wallet analysis
    wallet_age_days INTEGER,
    total_tokens_held INTEGER DEFAULT 1, -- Count of different tokens
    sol_balance NUMERIC(20,9),
    
    -- Behavioral flags
    is_active BOOLEAN DEFAULT TRUE,
    is_bot_suspected BOOLEAN DEFAULT FALSE,
    is_contract BOOLEAN DEFAULT FALSE,
    has_ens_domain BOOLEAN DEFAULT FALSE,
    
    -- Scoring
    wallet_score INTEGER,
    diamond_hand_score INTEGER, -- Based on holding duration
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    PRIMARY KEY (id),
    UNIQUE(token_id, wallet_address)
);

-- 3. Holder scores table for the scoring system
CREATE TABLE IF NOT EXISTS holder_scores (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    score_time TIMESTAMPTZ NOT NULL,
    bonding_curve_progress NUMERIC(5,2) NOT NULL CHECK (bonding_curve_progress >= 10 AND bonding_curve_progress <= 25),
    
    -- Score components (333 points total)
    distribution_score INTEGER NOT NULL CHECK (distribution_score >= 0 AND distribution_score <= 111),
    quality_score INTEGER NOT NULL CHECK (quality_score >= 0 AND quality_score <= 111),
    activity_score INTEGER NOT NULL CHECK (activity_score >= 0 AND activity_score <= 111),
    total_score INTEGER NOT NULL CHECK (total_score >= 0 AND total_score <= 333),
    
    -- Key metrics
    gini_coefficient NUMERIC(4,3),
    top_10_concentration NUMERIC(5,2),
    unique_holders INTEGER NOT NULL,
    avg_wallet_age_days NUMERIC(8,2),
    bot_ratio NUMERIC(4,3),
    organic_growth_score NUMERIC(4,3),
    
    -- Detailed breakdown
    score_details JSONB NOT NULL DEFAULT '{}',
    
    -- Alerts and flags
    red_flags TEXT[],
    yellow_flags TEXT[],
    positive_signals TEXT[],
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (token_id, score_time)
);

-- Convert to hypertable
SELECT create_hypertable('holder_scores', 'score_time', if_not_exists => TRUE);

-- 4. Wallet analysis cache (for performance)
CREATE TABLE IF NOT EXISTS wallet_analysis_cache (
    wallet_address VARCHAR(44) PRIMARY KEY,
    
    -- Wallet characteristics
    creation_date TIMESTAMPTZ,
    total_transactions INTEGER,
    unique_tokens_held INTEGER,
    total_volume_sol NUMERIC(20,9),
    
    -- Behavioral patterns
    avg_holding_duration_days NUMERIC(8,2),
    profit_loss_ratio NUMERIC(5,2),
    rug_count INTEGER DEFAULT 0,
    successful_trades INTEGER DEFAULT 0,
    
    -- Classification
    wallet_type VARCHAR(20), -- 'trader', 'holder', 'bot', 'mev', 'unknown'
    risk_score INTEGER, -- 0-100, higher is riskier
    
    -- ENS/Domain data
    has_domain BOOLEAN DEFAULT FALSE,
    domain_names TEXT[],
    
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_holder_snapshots_token_time ON holder_snapshots(token_id, snapshot_time DESC);
CREATE INDEX idx_holder_snapshots_progress ON holder_snapshots(bonding_curve_progress);
CREATE INDEX idx_holder_snapshots_holder_count ON holder_snapshots(holder_count);

CREATE INDEX idx_token_holders_token ON token_holders(token_id);
CREATE INDEX idx_token_holders_wallet ON token_holders(wallet_address);
CREATE INDEX idx_token_holders_balance ON token_holders(balance DESC);
CREATE INDEX idx_token_holders_active ON token_holders(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_token_holders_bots ON token_holders(is_bot_suspected) WHERE is_bot_suspected = TRUE;

CREATE INDEX idx_holder_scores_token_time ON holder_scores(token_id, score_time DESC);
CREATE INDEX idx_holder_scores_total ON holder_scores(total_score DESC);
CREATE INDEX idx_holder_scores_progress ON holder_scores(bonding_curve_progress);

CREATE INDEX idx_wallet_cache_type ON wallet_analysis_cache(wallet_type);
CREATE INDEX idx_wallet_cache_updated ON wallet_analysis_cache(last_updated);

-- Helper functions
CREATE OR REPLACE FUNCTION calculate_gini_coefficient(balances NUMERIC[])
RETURNS NUMERIC AS $$
DECLARE
    n INTEGER;
    total NUMERIC;
    gini_sum NUMERIC := 0;
    i INTEGER;
BEGIN
    n := array_length(balances, 1);
    IF n IS NULL OR n = 0 THEN
        RETURN 0;
    END IF;
    
    -- Sort balances
    balances := array(SELECT unnest(balances) ORDER BY 1);
    
    -- Calculate total
    total := 0;
    FOR i IN 1..n LOOP
        total := total + balances[i];
    END LOOP;
    
    IF total = 0 THEN
        RETURN 0;
    END IF;
    
    -- Calculate Gini coefficient
    FOR i IN 1..n LOOP
        gini_sum := gini_sum + (2 * i - n - 1) * balances[i];
    END LOOP;
    
    RETURN gini_sum / (n * total);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to classify wallet by balance percentage
CREATE OR REPLACE FUNCTION classify_holder(balance_percentage NUMERIC)
RETURNS TEXT AS $$
BEGIN
    IF balance_percentage >= 5 THEN
        RETURN 'whale';
    ELSIF balance_percentage >= 1 THEN
        RETURN 'large';
    ELSIF balance_percentage >= 0.1 THEN
        RETURN 'medium';
    ELSE
        RETURN 'small';
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Trigger to update wallet classification
CREATE OR REPLACE FUNCTION update_holder_metrics()
RETURNS TRIGGER AS $$
BEGIN
    -- Update balance percentage
    NEW.balance_percentage := (NEW.balance / 1000000000) * 100; -- Assuming 1B total supply
    
    -- Update wallet age if not set
    IF NEW.wallet_age_days IS NULL THEN
        NEW.wallet_age_days := EXTRACT(EPOCH FROM (NOW() - NEW.first_seen)) / 86400;
    END IF;
    
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_holder_metrics_trigger
BEFORE INSERT OR UPDATE ON token_holders
FOR EACH ROW
EXECUTE FUNCTION update_holder_metrics();

-- Add compression policy for time-series tables
SELECT add_compression_policy('holder_snapshots', INTERVAL '7 days');
SELECT add_compression_policy('holder_scores', INTERVAL '7 days');

-- Add retention policy (keep holder data for 180 days)
SELECT add_retention_policy('holder_snapshots', INTERVAL '180 days');
SELECT add_retention_policy('holder_scores', INTERVAL '180 days');

-- Add continuous aggregate refresh policy
SELECT add_continuous_aggregate_policy('holder_snapshots',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '5 minutes');

COMMIT;

-- Migration verification
DO $$
BEGIN
    RAISE NOTICE 'Holder tracking tables created successfully';
    RAISE NOTICE 'Tables created: holder_snapshots, token_holders, holder_scores, wallet_analysis_cache';
    RAISE NOTICE 'Helper functions: calculate_gini_coefficient, classify_holder';
    RAISE NOTICE 'Compression and retention policies applied';
END $$;