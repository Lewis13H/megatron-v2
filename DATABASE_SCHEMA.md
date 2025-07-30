# Database Schema Design for Megatron V2

## Overview

This document outlines the database schema design for Megatron V2, supporting the ingestion and analysis of 100,000+ tokens per week across Pump.fun and Raydium Launchpad platforms. The schema is designed for PostgreSQL with TimescaleDB extensions for efficient time-series data handling.

## Database Architecture

### Technology Stack
- **Primary Database**: PostgreSQL 15+ with TimescaleDB extension
- **Time-Series Data**: TimescaleDB hypertables for price/volume data
- **Cache Layer**: Redis for hot data and real-time scoring
- **Document Store**: PostgreSQL JSONB for flexible metadata storage

## Core Schema Design

### 1. Token Master Data

```sql
-- Core token information
CREATE TABLE tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mint_address VARCHAR(44) UNIQUE NOT NULL,
    symbol VARCHAR(10),
    name VARCHAR(100),
    decimals INTEGER NOT NULL DEFAULT 6,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('pumpfun', 'raydium_launchpad')),
    creation_signature VARCHAR(88) NOT NULL,
    creation_timestamp TIMESTAMPTZ NOT NULL,
    creator_address VARCHAR(44) NOT NULL,
    initial_supply NUMERIC(20,0),
    metadata JSONB,
    is_graduated BOOLEAN DEFAULT FALSE,
    graduation_timestamp TIMESTAMPTZ,
    graduation_signature VARCHAR(88),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tokens_mint_address ON tokens(mint_address);
CREATE INDEX idx_tokens_platform ON tokens(platform);
CREATE INDEX idx_tokens_creation_timestamp ON tokens(creation_timestamp);
CREATE INDEX idx_tokens_creator ON tokens(creator_address);
CREATE INDEX idx_tokens_graduated ON tokens(is_graduated);
```

### 2. Pool/Bonding Curve Data

```sql
-- Pool state for both platforms
CREATE TABLE pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_address VARCHAR(44) UNIQUE NOT NULL,
    token_id UUID REFERENCES tokens(id) NOT NULL,
    base_mint VARCHAR(44) NOT NULL,
    quote_mint VARCHAR(44) NOT NULL,
    platform VARCHAR(20) NOT NULL,
    initial_price NUMERIC(30,10),
    initial_base_liquidity NUMERIC(20,0),
    initial_quote_liquidity NUMERIC(20,0),
    
    -- Pump.fun specific
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
    
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pools_token_id ON pools(token_id);
CREATE INDEX idx_pools_platform ON pools(platform);
CREATE INDEX idx_pools_status ON pools(status);
```

### 3. Transaction Data (Time-Series)

```sql
-- All swap/trade transactions
CREATE TABLE transactions (
    signature VARCHAR(88) PRIMARY KEY,
    pool_id UUID REFERENCES pools(id) NOT NULL,
    token_id UUID REFERENCES tokens(id) NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    slot BIGINT NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('buy', 'sell', 'add_liquidity', 'remove_liquidity')),
    user_address VARCHAR(44) NOT NULL,
    
    -- Amounts (store raw values with decimals info)
    amount_in NUMERIC(30,0) NOT NULL,
    amount_in_decimals INTEGER NOT NULL,
    amount_out NUMERIC(30,0) NOT NULL,
    amount_out_decimals INTEGER NOT NULL,
    
    -- Calculated values
    sol_amount NUMERIC(20,9),  -- Normalized SOL amount
    token_amount NUMERIC(30,6), -- Normalized token amount
    price_per_token NUMERIC(30,10),
    
    -- Fees
    protocol_fee NUMERIC(20,0),
    platform_fee NUMERIC(20,0),
    share_fee NUMERIC(20,0),
    transaction_fee BIGINT,
    
    success BOOLEAN DEFAULT TRUE,
    error_code VARCHAR(50),
    raw_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('transactions', 'block_time');

-- Indexes for common queries
CREATE INDEX idx_transactions_token_id_time ON transactions(token_id, block_time DESC);
CREATE INDEX idx_transactions_pool_id_time ON transactions(pool_id, block_time DESC);
CREATE INDEX idx_transactions_user_time ON transactions(user_address, block_time DESC);
CREATE INDEX idx_transactions_type ON transactions(type);
```

### 4. Price/Volume Aggregates (Time-Series)

```sql
-- 1-minute candles for price and volume
CREATE TABLE price_candles_1m (
    token_id UUID REFERENCES tokens(id) NOT NULL,
    bucket TIMESTAMPTZ NOT NULL,
    open NUMERIC(30,10) NOT NULL,
    high NUMERIC(30,10) NOT NULL,
    low NUMERIC(30,10) NOT NULL,
    close NUMERIC(30,10) NOT NULL,
    volume_token NUMERIC(30,6) NOT NULL,
    volume_sol NUMERIC(20,9) NOT NULL,
    trade_count INTEGER NOT NULL,
    buyer_count INTEGER NOT NULL,
    seller_count INTEGER NOT NULL,
    PRIMARY KEY (token_id, bucket)
);

SELECT create_hypertable('price_candles_1m', 'bucket');

-- 5-minute candles (materialized from 1m)
CREATE TABLE price_candles_5m (
    token_id UUID REFERENCES tokens(id) NOT NULL,
    bucket TIMESTAMPTZ NOT NULL,
    open NUMERIC(30,10) NOT NULL,
    high NUMERIC(30,10) NOT NULL,
    low NUMERIC(30,10) NOT NULL,
    close NUMERIC(30,10) NOT NULL,
    volume_token NUMERIC(30,6) NOT NULL,
    volume_sol NUMERIC(20,9) NOT NULL,
    trade_count INTEGER NOT NULL,
    buyer_count INTEGER NOT NULL,
    seller_count INTEGER NOT NULL,
    PRIMARY KEY (token_id, bucket)
);

SELECT create_hypertable('price_candles_5m', 'bucket');
```

### 5. Holder Analytics

```sql
-- Holder snapshots taken periodically
CREATE TABLE holder_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    snapshot_time TIMESTAMPTZ NOT NULL,
    total_holders INTEGER NOT NULL,
    unique_holders INTEGER NOT NULL,
    
    -- Distribution metrics
    top_10_concentration NUMERIC(5,2),
    top_25_concentration NUMERIC(5,2),
    top_100_concentration NUMERIC(5,2),
    gini_coefficient NUMERIC(5,4),
    
    -- Holder categories
    holders_1_100 INTEGER DEFAULT 0,
    holders_100_1k INTEGER DEFAULT 0,
    holders_1k_10k INTEGER DEFAULT 0,
    holders_10k_100k INTEGER DEFAULT 0,
    holders_100k_plus INTEGER DEFAULT 0,
    
    -- Quality metrics
    average_holding_size NUMERIC(30,6),
    median_holding_size NUMERIC(30,6),
    diamond_hands_count INTEGER DEFAULT 0, -- Holders for >24h
    
    raw_distribution JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_holder_snapshots_token_time ON holder_snapshots(token_id, snapshot_time DESC);

-- Individual holder tracking for top holders
CREATE TABLE top_holders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    wallet_address VARCHAR(44) NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    current_balance NUMERIC(30,6),
    percentage_held NUMERIC(5,2),
    is_creator BOOLEAN DEFAULT FALSE,
    is_known_wallet BOOLEAN DEFAULT FALSE,
    wallet_tags TEXT[],
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(token_id, wallet_address)
);

CREATE INDEX idx_top_holders_token ON top_holders(token_id);
CREATE INDEX idx_top_holders_wallet ON top_holders(wallet_address);
```

### 6. Social Metrics

```sql
-- Social metrics from TweetScout and other sources
CREATE TABLE social_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    
    -- Twitter/X metrics
    twitter_followers INTEGER,
    twitter_mentions_1h INTEGER,
    twitter_mentions_24h INTEGER,
    twitter_engagement_rate NUMERIC(5,2),
    twitter_sentiment_score NUMERIC(3,2),
    influencer_mentions INTEGER,
    influencer_reach INTEGER,
    
    -- Community metrics
    telegram_members INTEGER,
    telegram_active_users INTEGER,
    telegram_messages_1h INTEGER,
    discord_members INTEGER,
    discord_active_users INTEGER,
    
    -- Aggregate metrics
    total_social_mentions INTEGER,
    social_growth_rate_1h NUMERIC(10,2),
    social_growth_rate_24h NUMERIC(10,2),
    
    raw_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_social_metrics_token_time ON social_metrics(token_id, timestamp DESC);
```

### 7. Scoring System

```sql
-- Token scores calculated periodically
CREATE TABLE token_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    calculated_at TIMESTAMPTZ NOT NULL,
    
    -- Main scores (out of 333 each)
    technical_score INTEGER NOT NULL CHECK (technical_score >= 0 AND technical_score <= 333),
    holder_score INTEGER NOT NULL CHECK (holder_score >= 0 AND holder_score <= 333),
    social_score INTEGER NOT NULL CHECK (social_score >= 0 AND social_score <= 333),
    total_score INTEGER GENERATED ALWAYS AS (technical_score + holder_score + social_score) STORED,
    
    -- Technical breakdown
    liquidity_score INTEGER,
    trading_score INTEGER,
    contract_score INTEGER,
    
    -- Holder breakdown
    distribution_score INTEGER,
    quality_score INTEGER,
    activity_score INTEGER,
    
    -- Social breakdown
    twitter_score INTEGER,
    community_score INTEGER,
    virality_score INTEGER,
    
    -- Multipliers and flags
    score_multiplier NUMERIC(3,2) DEFAULT 1.0,
    has_red_flags BOOLEAN DEFAULT FALSE,
    red_flags TEXT[],
    
    -- ML predictions
    ml_graduation_probability NUMERIC(5,4),
    ml_confidence_score NUMERIC(5,4),
    ml_model_version VARCHAR(20),
    
    score_details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_token_scores_token_time ON token_scores(token_id, calculated_at DESC);
CREATE INDEX idx_token_scores_total ON token_scores(total_score DESC);
CREATE INDEX idx_token_scores_ml_prob ON token_scores(ml_graduation_probability DESC);
```

### 8. Trading Signals & Performance

```sql
-- Trading signals generated by the system
CREATE TABLE trading_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    signal_time TIMESTAMPTZ NOT NULL,
    signal_type VARCHAR(20) NOT NULL CHECK (signal_type IN ('buy', 'sell', 'hold')),
    
    -- Signal details
    score_at_signal INTEGER NOT NULL,
    price_at_signal NUMERIC(30,10) NOT NULL,
    market_cap_at_signal NUMERIC(20,2),
    ml_probability_at_signal NUMERIC(5,4),
    
    -- Thresholds that triggered signal
    triggered_by TEXT[],
    signal_strength VARCHAR(20),
    
    -- Execution details (if acted upon)
    was_executed BOOLEAN DEFAULT FALSE,
    execution_time TIMESTAMPTZ,
    execution_price NUMERIC(30,10),
    execution_signature VARCHAR(88),
    
    -- Performance tracking
    peak_price NUMERIC(30,10),
    peak_time TIMESTAMPTZ,
    exit_price NUMERIC(30,10),
    exit_time TIMESTAMPTZ,
    realized_pnl NUMERIC(10,2),
    max_drawdown NUMERIC(10,2),
    
    signal_metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trading_signals_token ON trading_signals(token_id);
CREATE INDEX idx_trading_signals_time ON trading_signals(signal_time DESC);
CREATE INDEX idx_trading_signals_executed ON trading_signals(was_executed);
```

### 9. System Monitoring

```sql
-- Monitor performance and health metrics
CREATE TABLE system_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    metric_time TIMESTAMPTZ NOT NULL,
    metric_type VARCHAR(50) NOT NULL,
    
    -- Processing metrics
    transactions_processed INTEGER,
    tokens_monitored INTEGER,
    signals_generated INTEGER,
    
    -- Performance metrics
    avg_processing_latency_ms NUMERIC(10,2),
    p99_processing_latency_ms NUMERIC(10,2),
    grpc_stream_health VARCHAR(20),
    
    -- Resource usage
    memory_usage_mb INTEGER,
    cpu_usage_percent NUMERIC(5,2),
    
    metric_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

SELECT create_hypertable('system_metrics', 'metric_time');
```

## Continuous Aggregates

```sql
-- Hourly price/volume aggregates
CREATE MATERIALIZED VIEW price_candles_1h
WITH (timescaledb.continuous) AS
SELECT
    token_id,
    time_bucket('1 hour', bucket) AS bucket,
    first(open, bucket) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, bucket) AS close,
    sum(volume_token) AS volume_token,
    sum(volume_sol) AS volume_sol,
    sum(trade_count) AS trade_count,
    sum(buyer_count) AS buyer_count,
    sum(seller_count) AS seller_count
FROM price_candles_5m
GROUP BY token_id, time_bucket('1 hour', bucket);

-- Daily aggregates
CREATE MATERIALIZED VIEW price_candles_1d
WITH (timescaledb.continuous) AS
SELECT
    token_id,
    time_bucket('1 day', bucket) AS bucket,
    first(open, bucket) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, bucket) AS close,
    sum(volume_token) AS volume_token,
    sum(volume_sol) AS volume_sol,
    sum(trade_count) AS trade_count,
    sum(buyer_count) AS buyer_count,
    sum(seller_count) AS seller_count
FROM price_candles_1h
GROUP BY token_id, time_bucket('1 day', bucket);
```

## Data Retention Policies

```sql
-- Retention policies for time-series data
SELECT add_retention_policy('transactions', INTERVAL '90 days');
SELECT add_retention_policy('price_candles_1m', INTERVAL '7 days');
SELECT add_retention_policy('price_candles_5m', INTERVAL '30 days');
SELECT add_retention_policy('system_metrics', INTERVAL '30 days');

-- Compression policies for older data
SELECT add_compression_policy('transactions', INTERVAL '7 days');
SELECT add_compression_policy('price_candles_1m', INTERVAL '1 day');
SELECT add_compression_policy('price_candles_5m', INTERVAL '7 days');
```

## Redis Cache Schema

```redis
# Current token scores
token:score:{token_id} -> {
    "technical_score": 250,
    "holder_score": 275,
    "social_score": 190,
    "total_score": 715,
    "ml_probability": 0.8234,
    "last_updated": "2025-01-29T10:30:00Z"
}
TTL: 5 minutes

# Active trading signals
signal:active:{token_id} -> {
    "signal_type": "buy",
    "price": 0.00001234,
    "score": 750,
    "timestamp": "2025-01-29T10:30:00Z"
}
TTL: 1 hour

# Real-time price data
price:current:{token_id} -> {
    "price": 0.00001234,
    "volume_1h": 50000,
    "change_1h": 15.5,
    "last_trade": "2025-01-29T10:30:00Z"
}
TTL: 30 seconds

# Hot token list (sorted set by score)
tokens:hot -> [
    {token_id: score},
    ...
]
TTL: 1 minute
```

## Monitor Output Mappings

### 1. Raydium Launchpad New Token Monitor Output
- `timestamp` → `tokens.creation_timestamp`
- `signature` → `tokens.creation_signature`
- `poolState` → `pools.pool_address`
- `baseTokenMint` → `tokens.mint_address`, `pools.base_mint`
- `quoteTokenMint` → `pools.quote_mint`
- `initialPrice` → `pools.initial_price`
- `initialLiquidity` → `pools.initial_quote_liquidity`

### 2. Pump.fun New Token Monitor Output
- `Ca` (token mint) → `tokens.mint_address`
- Transaction metadata → `tokens.creation_signature`, `tokens.creation_timestamp`

### 3. Pump.fun Transaction Monitor Output
- `timestamp` → `transactions.block_time`
- `signature` → `transactions.signature`
- `type` → `transactions.type`
- `user` → `transactions.user_address`
- `mint` → Lookup `tokens.id` via `mint_address`
- `bondingCurve` → `pools.bonding_curve_address`
- `solAmount` → `transactions.sol_amount`
- `tokenAmount` → `transactions.token_amount`

### 4. Raydium Launchpad Transaction Monitor Output
- All transaction types → `transactions` table with appropriate type
- Pool creation data → `pools` table initialization
- Buy/Sell events → `transactions` with price calculations
- Event data (fees, amounts) → `transactions` fee columns

### 5. Bonding Curve Monitor Output
- Transaction impact → Calculate `pools.bonding_curve_progress` update
- Trade amounts → `transactions` table
- Progress tracking → Update `pools.real_sol_reserves`, `pools.real_token_reserves`

## Performance Considerations

1. **Partitioning**: All hypertables are automatically partitioned by time
2. **Indexing**: Strategic indexes on foreign keys and common query patterns
3. **Compression**: Automatic compression for data older than 7 days
4. **Continuous Aggregates**: Pre-computed aggregates for common time windows
5. **Connection Pooling**: Use PgBouncer for connection management
6. **Read Replicas**: Consider read replicas for analytics queries

## Migration Strategy

1. Create base tables in order (tokens → pools → transactions)
2. Set up TimescaleDB hypertables
3. Create continuous aggregates
4. Set up retention and compression policies
5. Populate Redis cache structure
6. Begin data ingestion with monitor systems

## Monitoring & Maintenance

1. **Daily Tasks**:
   - Check compression job status
   - Monitor table sizes and growth
   - Verify continuous aggregate refresh

2. **Weekly Tasks**:
   - Analyze query performance
   - Update table statistics
   - Review and optimize slow queries

3. **Monthly Tasks**:
   - Review retention policies
   - Audit index usage
   - Plan capacity for growth