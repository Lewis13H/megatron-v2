# Database Schema Design for Megatron V2

## Overview

This document outlines the complete database schema for Megatron V2, a sophisticated Solana memecoin trading system that analyzes 100,000+ tokens weekly. The schema is built on PostgreSQL 15+ with TimescaleDB extensions for efficient time-series data handling, supporting the 999-point scoring system (Technical/Holder/Social) and ML-driven graduation predictions.

## Database Architecture

### Technology Stack
- **Primary Database**: PostgreSQL 15+ with TimescaleDB 2.x
- **Time-Series Optimization**: Hypertables, continuous aggregates, compression
- **Document Store**: PostgreSQL JSONB for flexible metadata
- **Performance**: Connection pooling, 5-minute caching, batch operations

## Core Tables

### 1. Tokens (Master Entity)

```sql
CREATE TABLE tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mint_address VARCHAR(44) UNIQUE NOT NULL,
    symbol VARCHAR(10),
    name VARCHAR(100),
    decimals INTEGER NOT NULL DEFAULT 6,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('pumpfun', 'raydium_launchpad')),
    
    -- Creation metadata
    creation_signature VARCHAR(88) NOT NULL,
    creation_timestamp TIMESTAMPTZ NOT NULL,
    creator_address VARCHAR(44) NOT NULL,
    initial_supply NUMERIC(20,0),
    
    -- Graduation tracking
    is_graduated BOOLEAN DEFAULT FALSE,
    graduation_timestamp TIMESTAMPTZ,
    graduation_signature VARCHAR(88),
    graduation_platform VARCHAR(50), -- 'raydium', 'raydium_cpmm', 'moonshot', etc.
    
    -- IPFS metadata
    uri VARCHAR(255),
    image_url VARCHAR(500),
    metadata JSONB,
    
    -- Holder score tracking
    last_holder_score_progress NUMERIC(5,2),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_tokens_mint_address ON tokens(mint_address);
CREATE INDEX idx_tokens_platform ON tokens(platform);
CREATE INDEX idx_tokens_creation_timestamp ON tokens(creation_timestamp);
CREATE INDEX idx_tokens_graduated ON tokens(is_graduated);
CREATE INDEX idx_tokens_graduation_platform ON tokens(graduation_platform);
```

### 2. Pools (Liquidity Pool Management)

```sql
CREATE TABLE pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_address VARCHAR(44) UNIQUE NOT NULL,
    token_id UUID REFERENCES tokens(id) NOT NULL,
    base_mint VARCHAR(44) NOT NULL,
    quote_mint VARCHAR(44) NOT NULL,
    platform VARCHAR(50) NOT NULL, -- Extended for multiple platforms
    pool_type VARCHAR(20) DEFAULT 'initial', -- 'initial' or 'graduated'
    
    -- Pump.fun bonding curve specific
    bonding_curve_address VARCHAR(44),
    virtual_sol_reserves NUMERIC(20,0),
    virtual_token_reserves NUMERIC(20,0),
    real_sol_reserves NUMERIC(20,0),
    real_token_reserves NUMERIC(20,0),
    bonding_curve_progress NUMERIC(5,2),
    
    -- Raydium specific
    lp_mint VARCHAR(44),
    base_vault VARCHAR(44),
    quote_vault VARCHAR(44),
    
    -- Price tracking
    latest_price NUMERIC(30,20),
    latest_price_usd NUMERIC(30,10),
    initial_price NUMERIC(30,10),
    initial_base_liquidity NUMERIC(20,0),
    initial_quote_liquidity NUMERIC(20,0),
    
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_pools_token_id ON pools(token_id);
CREATE INDEX idx_pools_platform ON pools(platform);
CREATE INDEX idx_pools_pool_type ON pools(pool_type);
CREATE INDEX idx_pools_bonding_curve_progress ON pools(bonding_curve_progress);
```

### 3. Transactions (TimescaleDB Hypertable)

```sql
CREATE TABLE transactions (
    signature VARCHAR(88) NOT NULL,
    pool_id UUID REFERENCES pools(id) NOT NULL,
    token_id UUID REFERENCES tokens(id) NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    slot BIGINT NOT NULL,
    type VARCHAR(20) NOT NULL, -- 'buy', 'sell', 'add_liquidity', 'remove_liquidity'
    user_address VARCHAR(44) NOT NULL,
    
    -- Raw amounts with decimals
    amount_in NUMERIC(30,0) NOT NULL,
    amount_in_decimals INTEGER NOT NULL,
    amount_out NUMERIC(30,0) NOT NULL,
    amount_out_decimals INTEGER NOT NULL,
    
    -- Normalized amounts
    sol_amount NUMERIC(20,9),
    token_amount NUMERIC(30,6),
    price_per_token NUMERIC(30,10),
    
    -- USD values (auto-calculated via trigger)
    price_per_token_usd NUMERIC(30,10),
    sol_amount_usd NUMERIC(20,2),
    
    -- Fees
    protocol_fee NUMERIC(20,0),
    platform_fee NUMERIC(20,0),
    transaction_fee BIGINT,
    
    success BOOLEAN DEFAULT TRUE,
    raw_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    PRIMARY KEY (signature, block_time)
);

-- Convert to hypertable
SELECT create_hypertable('transactions', 'block_time');

-- Compression policy
ALTER TABLE transactions SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'token_id',
    timescaledb.compress_orderby = 'block_time DESC'
);
SELECT add_compression_policy('transactions', INTERVAL '7 days');
SELECT add_retention_policy('transactions', INTERVAL '90 days');
```

## Price Analytics Infrastructure

### 4. Price Candles (1-Minute Aggregates)

```sql
CREATE TABLE price_candles_1m (
    token_id UUID REFERENCES tokens(id) NOT NULL,
    bucket TIMESTAMPTZ NOT NULL,
    
    -- OHLC in SOL
    open NUMERIC(30,10) NOT NULL,
    high NUMERIC(30,10) NOT NULL,
    low NUMERIC(30,10) NOT NULL,
    close NUMERIC(30,10) NOT NULL,
    
    -- OHLC in USD
    open_usd NUMERIC(30,10),
    high_usd NUMERIC(30,10),
    low_usd NUMERIC(30,10),
    close_usd NUMERIC(30,10),
    
    -- Volume metrics
    volume_token NUMERIC(30,6) NOT NULL,
    volume_sol NUMERIC(20,9) NOT NULL,
    volume_usd NUMERIC(20,2),
    
    -- Trading metrics
    trade_count INTEGER NOT NULL,
    buyer_count INTEGER NOT NULL,
    seller_count INTEGER NOT NULL,
    
    PRIMARY KEY (token_id, bucket)
);

SELECT create_hypertable('price_candles_1m', 'bucket');
```

### 5. Price Continuous Aggregate (Real-time View)

```sql
CREATE MATERIALIZED VIEW price_candles_1m_cagg
WITH (timescaledb.continuous) AS
SELECT
    token_id,
    time_bucket('1 minute', block_time) AS bucket,
    first(price_per_token, block_time) AS open,
    max(price_per_token) AS high,
    min(price_per_token) AS low,
    last(price_per_token, block_time) AS close,
    sum(CASE WHEN type IN ('buy', 'sell') THEN token_amount ELSE 0 END) AS volume_token,
    sum(CASE WHEN type IN ('buy', 'sell') THEN sol_amount ELSE 0 END) AS volume_sol,
    count(*) AS trade_count,
    count(DISTINCT CASE WHEN type = 'buy' THEN user_address END) AS buyer_count,
    count(DISTINCT CASE WHEN type = 'sell' THEN user_address END) AS seller_count
FROM transactions
WHERE price_per_token IS NOT NULL AND price_per_token > 0
GROUP BY token_id, time_bucket('1 minute', block_time)
WITH NO DATA;

-- Refresh policy
SELECT add_continuous_aggregate_policy('price_candles_1m_cagg',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '2 minutes',
    schedule_interval => INTERVAL '1 minute');
```

### 6. SOL/USD Price Tracking

```sql
CREATE TABLE sol_usd_prices (
    id UUID DEFAULT gen_random_uuid(),
    price_time TIMESTAMPTZ NOT NULL,
    price_usd NUMERIC(20,6) NOT NULL,
    source VARCHAR(50) NOT NULL, -- 'pyth', 'jupiter', 'birdeye', 'hermes'
    confidence NUMERIC(20,6),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (price_time, source, id),
    UNIQUE(price_time, source)
);

SELECT create_hypertable('sol_usd_prices', 'price_time');

-- Continuous aggregate for efficient queries
CREATE MATERIALIZED VIEW sol_usd_candles_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', price_time) AS bucket,
    first(price_usd, price_time) AS open,
    max(price_usd) AS high,
    min(price_usd) AS low,
    last(price_usd, price_time) AS close,
    avg(price_usd) AS average,
    count(*) AS sample_count,
    source
FROM sol_usd_prices
GROUP BY time_bucket('1 minute', price_time), source
WITH NO DATA;
```

## Scoring Systems (999 Points Total)

### 7. Technical Scores (333 Points) - TimescaleDB Hypertable

```sql
CREATE TABLE technical_scores (
    token_mint VARCHAR(44) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    
    -- Market Cap Score (0-100)
    market_cap_score NUMERIC(5,2) DEFAULT 0,
    market_cap_usd NUMERIC(20,2),
    market_cap_velocity NUMERIC(10,4), -- % change per hour
    
    -- Bonding Curve Score (0-83)
    bonding_curve_score NUMERIC(5,2) DEFAULT 0,
    bonding_curve_progress NUMERIC(5,2),
    progress_velocity NUMERIC(10,4), -- % per hour
    progress_consistency NUMERIC(5,2),
    
    -- Trading Health Score (0-75)
    trading_health_score NUMERIC(5,2) DEFAULT 0,
    buy_sell_ratio NUMERIC(10,4),
    volume_trend NUMERIC(10,4),
    unique_traders_1h INTEGER,
    whale_concentration NUMERIC(5,2),
    
    -- Sell-off Response Score (-60 to 75)
    selloff_response_score NUMERIC(6,2) DEFAULT 0,
    price_drop_5m NUMERIC(10,4),
    price_drop_15m NUMERIC(10,4),
    price_drop_30m NUMERIC(10,4),
    recovery_strength NUMERIC(10,4),
    
    -- Total Score (0-333)
    total_score NUMERIC(6,2) GENERATED ALWAYS AS (
        market_cap_score + bonding_curve_score + 
        trading_health_score + selloff_response_score
    ) STORED,
    
    -- Metadata
    volume_24h_usd NUMERIC(20,2),
    transactions_1h INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    PRIMARY KEY (token_mint, timestamp)
);

SELECT create_hypertable('technical_scores', 'timestamp');

-- View for latest scores
CREATE VIEW latest_technical_scores AS
SELECT DISTINCT ON (token_mint)
    token_mint,
    timestamp,
    total_score,
    market_cap_score,
    bonding_curve_score,
    trading_health_score,
    selloff_response_score,
    market_cap_usd,
    bonding_curve_progress,
    volume_24h_usd
FROM technical_scores
ORDER BY token_mint, timestamp DESC;
```

### 8. Sell-off Events (Auto-detected)

```sql
CREATE TABLE selloff_events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    token_mint VARCHAR(44) NOT NULL,
    detection_time TIMESTAMPTZ NOT NULL,
    initial_price NUMERIC(30,10),
    lowest_price NUMERIC(30,10),
    drop_percentage NUMERIC(10,4),
    recovery_price NUMERIC(30,10),
    recovery_time TIMESTAMPTZ,
    recovery_percentage NUMERIC(10,4),
    duration_minutes INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_selloff_events_token ON selloff_events(token_mint);
CREATE INDEX idx_selloff_events_time ON selloff_events(detection_time);
```

### 9. Holder Scores V2 (333 Points) - TimescaleDB Hypertable

```sql
CREATE TABLE holder_scores (
    token_mint VARCHAR(44) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    
    -- Distribution Score (0-111)
    distribution_score NUMERIC(5,2) DEFAULT 0,
    gini_coefficient NUMERIC(5,4),
    theil_index NUMERIC(10,4),
    shannon_entropy NUMERIC(10,4),
    top_10_concentration NUMERIC(5,2),
    
    -- Quality Score (0-111)
    quality_score NUMERIC(5,2) DEFAULT 0,
    avg_wallet_age_days NUMERIC(10,2),
    smart_money_ratio NUMERIC(5,4),
    bot_wallet_ratio NUMERIC(5,4),
    known_dumper_ratio NUMERIC(5,4),
    
    -- Activity Score (0-111)
    activity_score NUMERIC(5,2) DEFAULT 0,
    holder_growth_rate NUMERIC(10,4),
    unique_buyers_1h INTEGER,
    unique_sellers_1h INTEGER,
    diamond_hands_ratio NUMERIC(5,4),
    avg_hold_time_hours NUMERIC(10,2),
    
    -- Total Score (0-333)
    total_score NUMERIC(6,2) GENERATED ALWAYS AS (
        distribution_score + quality_score + activity_score
    ) STORED,
    
    -- Metadata
    total_holders INTEGER,
    active_holders_24h INTEGER,
    new_holders_1h INTEGER,
    confidence_score NUMERIC(5,2), -- Data quality indicator
    data_completeness NUMERIC(5,2), -- % of data available
    
    -- Constraints
    bonding_curve_progress NUMERIC(5,2),
    is_frozen BOOLEAN DEFAULT FALSE, -- Frozen at 100% progress
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (token_mint, timestamp),
    
    -- Only calculate between 10% and <100% progress
    CONSTRAINT valid_progress CHECK (
        (bonding_curve_progress >= 10 AND bonding_curve_progress < 100) 
        OR is_frozen = TRUE
    )
);

SELECT create_hypertable('holder_scores', 'timestamp');

-- View for latest scores
CREATE VIEW latest_holder_scores_v2 AS
SELECT DISTINCT ON (hs.token_mint)
    hs.token_mint,
    hs.timestamp,
    hs.total_score,
    hs.distribution_score,
    hs.quality_score,
    hs.activity_score,
    hs.total_holders,
    hs.bonding_curve_progress,
    hs.confidence_score,
    rm.concentration_risk,
    rm.rug_risk_score
FROM holder_scores hs
LEFT JOIN risk_metrics rm ON 
    hs.token_mint = rm.token_mint 
    AND rm.timestamp = (
        SELECT MAX(timestamp) 
        FROM risk_metrics 
        WHERE token_mint = hs.token_mint
    )
WHERE hs.is_frozen = FALSE OR hs.bonding_curve_progress < 100
ORDER BY hs.token_mint, hs.timestamp DESC;
```

## Holder Analysis Infrastructure

### 10. Holder Snapshots (TimescaleDB Hypertable)

```sql
CREATE TABLE holder_snapshots (
    token_mint VARCHAR(44) NOT NULL,
    snapshot_time TIMESTAMPTZ NOT NULL,
    
    -- Distribution metrics
    total_holders INTEGER NOT NULL,
    active_holders INTEGER, -- Holders with recent activity
    dust_accounts INTEGER, -- Accounts with <$1 worth
    
    -- Inequality metrics
    gini_coefficient NUMERIC(5,4),
    theil_index NUMERIC(10,4),
    shannon_entropy NUMERIC(10,4),
    
    -- Concentration metrics
    top_1_balance NUMERIC(30,6),
    top_10_balance NUMERIC(30,6),
    top_20_balance NUMERIC(30,6),
    top_50_balance NUMERIC(30,6),
    top_100_balance NUMERIC(30,6),
    
    -- Percentages
    top_1_percentage NUMERIC(5,2),
    top_10_percentage NUMERIC(5,2),
    top_20_percentage NUMERIC(5,2),
    top_50_percentage NUMERIC(5,2),
    top_100_percentage NUMERIC(5,2),
    
    -- Metadata
    data_source VARCHAR(50), -- 'helius_rpc', 'websocket', 'api'
    bonding_curve_progress NUMERIC(5,2),
    market_cap_usd NUMERIC(20,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    PRIMARY KEY (token_mint, snapshot_time)
);

SELECT create_hypertable('holder_snapshots', 'snapshot_time');
```

### 11. Token Holders (Individual Tracking)

```sql
CREATE TABLE token_holders (
    id UUID DEFAULT gen_random_uuid(),
    token_mint VARCHAR(44) NOT NULL,
    wallet_address VARCHAR(44) NOT NULL,
    
    -- Balance tracking
    current_balance NUMERIC(30,6) NOT NULL,
    initial_balance NUMERIC(30,6),
    peak_balance NUMERIC(30,6),
    
    -- Transaction history
    first_transaction_time TIMESTAMPTZ,
    last_transaction_time TIMESTAMPTZ,
    total_bought NUMERIC(30,6) DEFAULT 0,
    total_sold NUMERIC(30,6) DEFAULT 0,
    transaction_count INTEGER DEFAULT 0,
    
    -- Profit/Loss tracking
    avg_buy_price NUMERIC(30,10),
    avg_sell_price NUMERIC(30,10),
    realized_pnl NUMERIC(20,2),
    unrealized_pnl NUMERIC(20,2),
    
    -- Behavioral flags
    is_smart_money BOOLEAN DEFAULT FALSE,
    is_bot BOOLEAN DEFAULT FALSE,
    is_mev_bot BOOLEAN DEFAULT FALSE,
    is_insider BOOLEAN DEFAULT FALSE,
    diamond_hands_score NUMERIC(5,2),
    
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    PRIMARY KEY (token_mint, wallet_address),
    UNIQUE(token_mint, wallet_address)
);

CREATE INDEX idx_token_holders_balance ON token_holders(current_balance DESC);
CREATE INDEX idx_token_holders_smart_money ON token_holders(is_smart_money) WHERE is_smart_money = TRUE;
```

### 12. Wallet Analysis Cache

```sql
CREATE TABLE wallet_analysis_cache (
    wallet_address VARCHAR(44) PRIMARY KEY,
    
    -- Wallet metrics
    wallet_age_days INTEGER,
    total_transactions INTEGER,
    unique_tokens_traded INTEGER,
    
    -- Performance metrics
    win_rate NUMERIC(5,2),
    avg_profit_per_trade NUMERIC(10,2),
    total_profit_usd NUMERIC(20,2),
    best_trade_return NUMERIC(10,2),
    
    -- Risk metrics
    rug_pull_participation INTEGER DEFAULT 0,
    known_scammer BOOLEAN DEFAULT FALSE,
    mev_bot_likelihood NUMERIC(5,2),
    
    -- Classification
    wallet_type VARCHAR(50), -- 'retail', 'whale', 'bot', 'smart_money', 'insider'
    reputation_score NUMERIC(5,2),
    
    last_analyzed TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 13. Wallet Quality Metrics

```sql
CREATE TABLE wallet_quality_metrics (
    snapshot_id UUID REFERENCES holder_snapshots(snapshot_time, token_mint),
    token_mint VARCHAR(44) NOT NULL,
    snapshot_time TIMESTAMPTZ NOT NULL,
    
    -- Age distribution
    avg_wallet_age_days NUMERIC(10,2),
    median_wallet_age_days NUMERIC(10,2),
    new_wallets_percentage NUMERIC(5,2), -- < 7 days old
    
    -- Bot detection
    suspected_bots INTEGER,
    confirmed_bots INTEGER,
    mev_bots INTEGER,
    bot_percentage NUMERIC(5,2),
    
    -- Smart money
    smart_money_wallets INTEGER,
    smart_money_percentage NUMERIC(5,2),
    smart_money_holdings NUMERIC(30,6),
    
    -- Behavioral patterns
    diamond_hands_count INTEGER,
    paper_hands_count INTEGER,
    avg_hold_duration_hours NUMERIC(10,2),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (token_mint, snapshot_time)
);
```

### 14. Activity Metrics (TimescaleDB Hypertable)

```sql
CREATE TABLE activity_metrics (
    token_mint VARCHAR(44) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    
    -- Transaction velocity
    buys_1m INTEGER DEFAULT 0,
    sells_1m INTEGER DEFAULT 0,
    net_flow_1m NUMERIC(20,9), -- Net SOL flow
    
    buys_5m INTEGER DEFAULT 0,
    sells_5m INTEGER DEFAULT 0,
    net_flow_5m NUMERIC(20,9),
    
    buys_1h INTEGER DEFAULT 0,
    sells_1h INTEGER DEFAULT 0,
    net_flow_1h NUMERIC(20,9),
    
    -- Unique actors
    unique_buyers_1h INTEGER,
    unique_sellers_1h INTEGER,
    new_holders_1h INTEGER,
    
    -- Volume patterns
    avg_buy_size_sol NUMERIC(20,9),
    avg_sell_size_sol NUMERIC(20,9),
    largest_buy_sol NUMERIC(20,9),
    largest_sell_sol NUMERIC(20,9),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (token_mint, timestamp)
);

SELECT create_hypertable('activity_metrics', 'timestamp');
```

### 15. Risk Metrics (TimescaleDB Hypertable)

```sql
CREATE TABLE risk_metrics (
    token_mint VARCHAR(44) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    
    -- Concentration risk
    concentration_risk NUMERIC(5,2), -- 0-100 scale
    single_wallet_dominance BOOLEAN DEFAULT FALSE,
    whale_coordination_detected BOOLEAN DEFAULT FALSE,
    
    -- Bot risk
    bot_activity_score NUMERIC(5,2), -- 0-100 scale
    bot_swarm_detected BOOLEAN DEFAULT FALSE,
    mev_bot_percentage NUMERIC(5,2),
    
    -- Rug risk indicators
    rug_risk_score NUMERIC(5,2), -- 0-100 scale
    creator_dumping BOOLEAN DEFAULT FALSE,
    insider_selling BOOLEAN DEFAULT FALSE,
    liquidity_removal_risk NUMERIC(5,2),
    
    -- Manipulation indicators
    wash_trading_score NUMERIC(5,2),
    pump_dump_pattern BOOLEAN DEFAULT FALSE,
    coordinated_buying BOOLEAN DEFAULT FALSE,
    
    -- Overall risk
    overall_risk_score NUMERIC(5,2) GENERATED ALWAYS AS (
        GREATEST(concentration_risk, bot_activity_score, rug_risk_score, wash_trading_score)
    ) STORED,
    
    confidence_level NUMERIC(5,2), -- Confidence in risk assessment
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (token_mint, timestamp)
);

SELECT create_hypertable('risk_metrics', 'timestamp');
```

## Supporting Infrastructure

### 16. Holder Score Queue

```sql
CREATE TABLE holder_score_queue (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    token_mint VARCHAR(44) NOT NULL,
    priority INTEGER DEFAULT 5,
    reason VARCHAR(100), -- 'milestone_crossed', 'high_volume', 'velocity_change'
    
    -- Deduplication
    scheduled_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    
    UNIQUE(token_mint, processed_at)
);

CREATE INDEX idx_queue_priority ON holder_score_queue(priority DESC, scheduled_at ASC) 
WHERE processed_at IS NULL;
```

### 17. API Credit Usage (TimescaleDB Hypertable)

```sql
CREATE TABLE api_credit_usage (
    timestamp TIMESTAMPTZ NOT NULL,
    api_provider VARCHAR(50) NOT NULL, -- 'helius', 'birdeye', 'jupiter'
    endpoint VARCHAR(100) NOT NULL,
    
    credits_used INTEGER NOT NULL,
    response_time_ms INTEGER,
    status_code INTEGER,
    error_message TEXT,
    
    token_mint VARCHAR(44),
    request_type VARCHAR(50),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (timestamp, api_provider, endpoint)
);

SELECT create_hypertable('api_credit_usage', 'timestamp');

-- Add retention policy (90 days)
SELECT add_retention_policy('api_credit_usage', INTERVAL '90 days');
```

### 18. Holder Updates (Real-time WebSocket)

```sql
CREATE TABLE holder_updates (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    token_mint VARCHAR(44) NOT NULL,
    update_time TIMESTAMPTZ NOT NULL,
    update_type VARCHAR(50), -- 'balance_change', 'new_holder', 'holder_exit'
    
    wallet_address VARCHAR(44) NOT NULL,
    old_balance NUMERIC(30,6),
    new_balance NUMERIC(30,6),
    balance_change NUMERIC(30,6),
    
    -- Impact metrics
    impact_on_concentration NUMERIC(10,4),
    new_holder_count INTEGER,
    
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_holder_updates_mint ON holder_updates(token_mint, update_time DESC);
CREATE INDEX idx_holder_updates_unprocessed ON holder_updates(processed) WHERE processed = FALSE;
```

## Key Functions and Triggers

### Technical Score Functions

```sql
-- Calculate sell-off detection across multiple windows
CREATE OR REPLACE FUNCTION detect_selloff(
    p_token_mint VARCHAR(44),
    p_timestamp TIMESTAMPTZ DEFAULT NOW()
) RETURNS TABLE (
    is_selloff BOOLEAN,
    drop_5m NUMERIC,
    drop_15m NUMERIC,
    drop_30m NUMERIC,
    severity VARCHAR(20)
);

-- Calculate market cap velocity
CREATE OR REPLACE FUNCTION calculate_market_cap_velocity(
    p_token_mint VARCHAR(44),
    p_interval INTERVAL DEFAULT '1 hour'
) RETURNS NUMERIC;

-- Calculate bonding curve velocity
CREATE OR REPLACE FUNCTION calculate_progress_velocity(
    p_token_mint VARCHAR(44),
    p_interval INTERVAL DEFAULT '1 hour'
) RETURNS NUMERIC;
```

### Holder Analysis Functions

```sql
-- Calculate Gini coefficient for wealth distribution
CREATE OR REPLACE FUNCTION calculate_gini_coefficient(
    balances NUMERIC[]
) RETURNS NUMERIC;

-- Calculate Shannon entropy for distribution randomness
CREATE OR REPLACE FUNCTION calculate_shannon_entropy(
    balances NUMERIC[]
) RETURNS NUMERIC;

-- Calculate Theil index for inequality
CREATE OR REPLACE FUNCTION calculate_theil_index(
    balances NUMERIC[]
) RETURNS NUMERIC;

-- Detect smart money wallets
CREATE OR REPLACE FUNCTION is_smart_money_wallet(
    p_wallet_address VARCHAR(44)
) RETURNS BOOLEAN;
```

### Triggers

```sql
-- Auto-update USD prices on transaction insert
CREATE TRIGGER update_transaction_usd_values
BEFORE INSERT ON transactions
FOR EACH ROW
EXECUTE FUNCTION calculate_usd_values();

-- Auto-detect sell-off events
CREATE TRIGGER detect_selloff_event
AFTER INSERT ON technical_scores
FOR EACH ROW
WHEN (NEW.price_drop_15m > 10)
EXECUTE FUNCTION create_selloff_event();

-- Queue holder score updates on milestones
CREATE TRIGGER queue_holder_score_update
AFTER UPDATE ON pools
FOR EACH ROW
WHEN (
    (OLD.bonding_curve_progress < 10 AND NEW.bonding_curve_progress >= 10) OR
    (OLD.bonding_curve_progress < 25 AND NEW.bonding_curve_progress >= 25) OR
    (OLD.bonding_curve_progress < 50 AND NEW.bonding_curve_progress >= 50) OR
    (OLD.bonding_curve_progress < 75 AND NEW.bonding_curve_progress >= 75)
)
EXECUTE FUNCTION queue_holder_score_calculation();
```

## Materialized Views

### Smart Money Wallets
```sql
CREATE MATERIALIZED VIEW smart_money_wallets AS
SELECT 
    wallet_address,
    win_rate,
    avg_profit_per_trade,
    total_profit_usd,
    unique_tokens_traded,
    reputation_score
FROM wallet_analysis_cache
WHERE wallet_type = 'smart_money'
  AND win_rate > 60
  AND unique_tokens_traded > 10
ORDER BY total_profit_usd DESC
LIMIT 1000;

-- Refresh daily
CREATE INDEX idx_smart_money_address ON smart_money_wallets(wallet_address);
```

### Top Tokens by Volume
```sql
CREATE MATERIALIZED VIEW top_tokens_by_usd_volume AS
SELECT 
    t.id as token_id,
    t.mint_address,
    t.symbol,
    t.name,
    t.platform,
    p.bonding_curve_progress,
    p.latest_price_usd,
    COALESCE(v.volume_24h_usd, 0) as volume_24h_usd,
    COALESCE(ts.total_score, 0) as technical_score,
    COALESCE(hs.total_score, 0) as holder_score,
    t.created_at
FROM tokens t
LEFT JOIN pools p ON t.id = p.token_id
LEFT JOIN LATERAL (
    SELECT SUM(volume_usd) as volume_24h_usd
    FROM price_candles_1m
    WHERE token_id = t.id
      AND bucket > NOW() - INTERVAL '24 hours'
) v ON true
LEFT JOIN latest_technical_scores ts ON t.mint_address = ts.token_mint
LEFT JOIN latest_holder_scores_v2 hs ON t.mint_address = hs.token_mint
WHERE t.created_at > NOW() - INTERVAL '7 days'
ORDER BY volume_24h_usd DESC;

-- Refresh every 5 minutes
```

## Data Retention and Optimization

### Compression Policies
```sql
-- Transaction data
ALTER TABLE transactions SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'token_id',
    timescaledb.compress_orderby = 'block_time DESC'
);
SELECT add_compression_policy('transactions', INTERVAL '7 days');

-- Price data
ALTER TABLE price_candles_1m SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'token_id',
    timescaledb.compress_orderby = 'bucket DESC'
);
SELECT add_compression_policy('price_candles_1m', INTERVAL '7 days');

-- Score data
SELECT add_compression_policy('technical_scores', INTERVAL '30 days');
SELECT add_compression_policy('holder_scores', INTERVAL '30 days');
```

### Retention Policies
```sql
-- Keep transaction data for 90 days
SELECT add_retention_policy('transactions', INTERVAL '90 days');

-- Keep minute candles for 30 days
SELECT add_retention_policy('price_candles_1m', INTERVAL '30 days');

-- Keep score history for 60 days
SELECT add_retention_policy('technical_scores', INTERVAL '60 days');
SELECT add_retention_policy('holder_scores', INTERVAL '60 days');

-- Keep API usage for 90 days
SELECT add_retention_policy('api_credit_usage', INTERVAL '90 days');
```

## Migration Order

Execute migrations in this sequence:

1. **001_create_tokens_table.sql** - Core token entity
2. **002_create_pools_table.sql** - Pool management
3. **003_create_transactions_hypertable.sql** - Transaction time-series
4. **004_create_price_aggregates.sql** - Price candles
5. **005_create_price_continuous_aggregate.sql** - Real-time price view
6. **006_add_latest_price_to_pools.sql** - Pool price tracking
7. **007_create_token_scores_table.sql** - Legacy scoring (deprecated)
8. **008_create_sol_usd_prices.sql** - SOL/USD price tracking
9. **009_create_sol_usd_continuous_aggregate.sql** - SOL price aggregates
10. **010_add_usd_price_enhancements.sql** - USD calculations
11. **011_fix_token_stats_function.sql** - Function fixes
12. **012_fix_materialized_view_refresh.sql** - View optimization
13. **013_fix_backfill_function.sql** - Backfill improvements
14. **014_add_usd_prices_to_pools.sql** - Pool USD prices
15. **014_create_holder_tracking_tables_fixed.sql** - Holder infrastructure
16. **015_technical_scoring_system.sql** - Technical scoring (333 points)
17. **015_add_frozen_score_field.sql** - Score freezing at 100%
18. **016_update_holder_score_constraints.sql** - Holder score rules
19. **017_add_holder_score_triggers.sql** - Automated scoring
20. **018_add_graduated_platforms.sql** - Multi-platform graduation
21. **018_holder_analysis_v2.sql** - Enhanced holder analysis

## Performance Considerations

### Index Strategy
- Primary lookups: token_mint, pool_address, wallet_address
- Time-series queries: Always include time-based indexes
- Partial indexes for filtered queries (e.g., WHERE is_graduated = true)

### Query Optimization
- Use continuous aggregates for real-time analytics
- Leverage TimescaleDB's chunk exclusion for time queries
- Implement connection pooling (max 100 connections)
- Cache frequently accessed data (5-minute TTL)

### Monitoring
- Track slow queries > 100ms
- Monitor compression ratios
- Watch connection pool saturation
- Alert on retention policy failures

## Future Enhancements

### Planned Tables (Not Yet Implemented)
- **social_scores**: 333-point social scoring from TweetScout API
- **trading_signals**: ML-generated buy/sell signals
- **graduation_predictions**: ML model outputs
- **backtest_results**: Strategy performance tracking
- **alert_configurations**: User-defined alerts
- **audit_log**: System activity tracking

### Planned Features
- 5-minute, 1-hour, 1-day price aggregates
- Cross-token correlation analysis
- Network effect scoring
- Liquidity depth tracking
- MEV protection metrics