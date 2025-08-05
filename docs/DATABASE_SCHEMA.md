# Database Schema Design for Megatron V2

## Overview

This document outlines the database schema design for Megatron V2, supporting the ingestion and analysis of 100,000+ tokens per week across Pump.fun and Raydium Launchpad platforms. The schema is designed for PostgreSQL with TimescaleDB extensions for efficient time-series data handling.

## Database Architecture

### Technology Stack
- **Primary Database**: PostgreSQL 15+ with TimescaleDB extension
- **Time-Series Data**: TimescaleDB hypertables for price/volume data
- **Cache Layer**: Redis for hot data and real-time scoring
- **Document Store**: PostgreSQL JSONB for flexible metadata storage

## Current Schema (As Implemented)

### 1. Token Master Data

```sql
-- Core token information (001_create_tokens_table.sql)
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

-- Indexes
CREATE INDEX idx_tokens_mint_address ON tokens(mint_address);
CREATE INDEX idx_tokens_platform ON tokens(platform);
CREATE INDEX idx_tokens_creation_timestamp ON tokens(creation_timestamp);
CREATE INDEX idx_tokens_creator ON tokens(creator_address);
CREATE INDEX idx_tokens_graduated ON tokens(is_graduated);
```

### 2. Pool/Bonding Curve Data

```sql
-- Pool state for both platforms (002_create_pools_table.sql)
CREATE TABLE pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_address VARCHAR(44) UNIQUE NOT NULL,
    token_id UUID REFERENCES tokens(id) NOT NULL,
    base_mint VARCHAR(44) NOT NULL,
    quote_mint VARCHAR(44) NOT NULL,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('pumpfun', 'raydium_launchpad')),
    initial_price NUMERIC(30,10),
    initial_base_liquidity NUMERIC(20,0),
    initial_quote_liquidity NUMERIC(20,0),
    
    -- Pump.fun specific fields
    bonding_curve_address VARCHAR(44),
    virtual_sol_reserves NUMERIC(20,0),
    virtual_token_reserves NUMERIC(20,0),
    real_sol_reserves NUMERIC(20,0),
    real_token_reserves NUMERIC(20,0),
    bonding_curve_progress NUMERIC(5,2),
    
    -- Raydium specific fields
    lp_mint VARCHAR(44),
    base_vault VARCHAR(44),
    quote_vault VARCHAR(44),
    
    -- Price tracking (006_add_latest_price_to_pools.sql)
    latest_price NUMERIC(30,20),
    
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'graduated', 'closed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_pools_token_id ON pools(token_id);
CREATE INDEX idx_pools_platform ON pools(platform);
CREATE INDEX idx_pools_pool_address ON pools(pool_address);
CREATE INDEX idx_pools_status ON pools(status);
CREATE INDEX idx_pools_created_at ON pools(created_at DESC);
CREATE INDEX idx_pools_latest_price ON pools(latest_price);
```

### 3. Transaction Data (Time-Series)

```sql
-- All swap/trade transactions (003_create_transactions_hypertable.sql)
CREATE TABLE transactions (
    signature VARCHAR(88) NOT NULL,
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
    sol_amount NUMERIC(20,9),        -- Normalized SOL amount
    token_amount NUMERIC(30,6),      -- Normalized token amount
    price_per_token NUMERIC(30,10),  -- Price at time of transaction
    
    -- USD values (010_add_usd_price_enhancements.sql)
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

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('transactions', 'block_time');

-- Indexes
CREATE INDEX idx_transactions_signature ON transactions(signature);
CREATE INDEX idx_transactions_token_id_time ON transactions(token_id, block_time DESC);
CREATE INDEX idx_transactions_pool_id_time ON transactions(pool_id, block_time DESC);
CREATE INDEX idx_transactions_user_time ON transactions(user_address, block_time DESC);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_success ON transactions(success) WHERE success = false;
CREATE INDEX idx_transactions_token_type_time ON transactions(token_id, type, block_time DESC);
```

### 4. Price/Volume Aggregates (Time-Series)

```sql
-- 1-minute candles for price and volume (004_create_price_aggregates.sql)
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
    
    -- USD values (010_add_usd_price_enhancements.sql)
    open_usd NUMERIC(30,10),
    high_usd NUMERIC(30,10),
    low_usd NUMERIC(30,10),
    close_usd NUMERIC(30,10),
    volume_usd NUMERIC(20,2),
    
    PRIMARY KEY (token_id, bucket)
);

SELECT create_hypertable('price_candles_1m', 'bucket', if_not_exists => TRUE);

-- Continuous aggregate (005_create_price_continuous_aggregate.sql)
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
GROUP BY token_id, time_bucket('1 minute', block_time);
```

### 5. SOL/USD Price Tracking

```sql
-- Historical SOL/USD prices (008_create_sol_usd_prices.sql)
CREATE TABLE sol_usd_prices (
    id UUID DEFAULT gen_random_uuid(),
    price_time TIMESTAMPTZ NOT NULL,
    price_usd NUMERIC(20,6) NOT NULL,
    source VARCHAR(50) NOT NULL, -- 'pyth', 'jupiter', 'birdeye', etc.
    confidence NUMERIC(20,6), -- Pyth confidence interval
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (price_time, source, id),
    UNIQUE(price_time, source)
);

SELECT create_hypertable('sol_usd_prices', 'price_time', if_not_exists => TRUE);

-- Continuous aggregate (009_create_sol_usd_continuous_aggregate.sql)
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
GROUP BY time_bucket('1 minute', price_time), source;
```

### 6. Token Scoring System

```sql
-- Token scores (007_create_token_scores_table.sql)
CREATE TABLE token_scores (
    token_address VARCHAR(66) PRIMARY KEY,
    total_score INTEGER NOT NULL DEFAULT 0,
    technical_score INTEGER NOT NULL DEFAULT 0,
    holder_score INTEGER NOT NULL DEFAULT 0,
    social_score INTEGER NOT NULL DEFAULT 0,
    graduation_probability DECIMAL(5,2) DEFAULT 0,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_token_address FOREIGN KEY (token_address) REFERENCES tokens(mint_address)
);

-- Indexes
CREATE INDEX idx_token_scores_total ON token_scores(total_score DESC);
CREATE INDEX idx_token_scores_updated ON token_scores(last_updated);
```

## Key Functions

### Price Analytics Functions

```sql
-- Get latest price for a token
get_latest_price(p_token_id UUID) 
RETURNS TABLE (
    price NUMERIC(30,10),
    bucket_time TIMESTAMPTZ,
    volume_sol_1h NUMERIC(20,9),
    trade_count_1h INTEGER
)

-- Get price change over time
get_price_change(p_token_id UUID, p_interval INTERVAL)
RETURNS TABLE (
    current_price NUMERIC(30,10),
    previous_price NUMERIC(30,10),
    price_change NUMERIC(30,10),
    price_change_percent NUMERIC(10,2)
)

-- Get transaction volume statistics
get_transaction_volume_stats(p_token_id UUID, p_interval INTERVAL)
RETURNS TABLE (
    total_volume_sol NUMERIC,
    total_volume_token NUMERIC,
    buy_volume_sol NUMERIC,
    sell_volume_sol NUMERIC,
    transaction_count BIGINT,
    unique_traders BIGINT,
    avg_transaction_size_sol NUMERIC
)

-- Get SOL/USD price at a specific time
get_sol_usd_price(p_timestamp TIMESTAMPTZ)
RETURNS NUMERIC

-- Get token stats with USD values
get_token_stats_with_usd(p_token_id UUID)
RETURNS TABLE (
    token_id UUID,
    latest_price_sol NUMERIC,
    latest_price_usd NUMERIC,
    volume_24h_sol NUMERIC,
    volume_24h_usd NUMERIC,
    high_24h_sol NUMERIC,
    high_24h_usd NUMERIC,
    low_24h_sol NUMERIC,
    low_24h_usd NUMERIC,
    price_change_24h_pct NUMERIC,
    last_updated TIMESTAMPTZ
)
```

## Key Views

### High Volume Tokens View
```sql
CREATE VIEW high_volume_tokens AS
SELECT 
    t.mint_address,
    t.symbol,
    t.name,
    pc.token_id,
    sum(pc.volume_sol) as volume_sol_1h,
    sum(pc.trade_count) as trade_count_1h,
    avg(pc.close) as avg_price_1h,
    max(pc.high) as high_1h,
    min(pc.low) as low_1h
FROM price_candles_1m_cagg pc
JOIN tokens t ON pc.token_id = t.id
WHERE pc.bucket > NOW() - INTERVAL '1 hour'
GROUP BY t.mint_address, t.symbol, t.name, pc.token_id
HAVING sum(pc.volume_sol) > 10  -- More than 10 SOL volume
ORDER BY volume_sol_1h DESC;
```

### Recent Transactions View
```sql
CREATE VIEW recent_transactions AS
SELECT 
    t.signature,
    t.block_time,
    t.type,
    t.user_address,
    t.sol_amount,
    t.token_amount,
    t.price_per_token,
    tok.symbol,
    tok.name,
    p.platform
FROM transactions t
JOIN tokens tok ON t.token_id = tok.id
JOIN pools p ON t.pool_id = p.id
WHERE t.block_time > NOW() - INTERVAL '24 hours'
ORDER BY t.block_time DESC;
```

### Top Tokens by USD Volume (Materialized View)
```sql
CREATE MATERIALIZED VIEW top_tokens_by_usd_volume AS
SELECT 
    t.id as token_id,
    t.mint_address,
    t.symbol,
    t.name,
    t.platform,
    COALESCE(
        (SELECT close_usd 
         FROM price_candles_1m pc 
         WHERE pc.token_id = t.id 
         ORDER BY bucket DESC 
         LIMIT 1), 
        0
    ) as latest_price_usd,
    COALESCE(
        (SELECT SUM(volume_usd) 
         FROM price_candles_1m pc 
         WHERE pc.token_id = t.id 
           AND pc.bucket > NOW() - INTERVAL '24 hours'), 
        0
    ) as volume_24h_usd,
    t.created_at
FROM tokens t
WHERE t.created_at > NOW() - INTERVAL '7 days';
```

## Data Retention and Compression

```sql
-- Compression policies
ALTER TABLE transactions SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'token_id',
    timescaledb.compress_orderby = 'block_time DESC'
);
SELECT add_compression_policy('transactions', INTERVAL '7 days');
SELECT add_compression_policy('price_candles_1m', INTERVAL '7 days');

-- Retention policies
SELECT add_retention_policy('transactions', INTERVAL '90 days');
```

## Monitor Output Mappings

### 1. Pump.fun New Token Monitor Output
- `Ca` (token mint) → `tokens.mint_address`
- `mint` → `tokens.mint_address`
- `symbol` → `tokens.symbol`
- `name` → `tokens.name`
- `decimals` → `tokens.decimals`
- Transaction metadata → `tokens.creation_signature`, `tokens.creation_timestamp`
- `creatorAddress` → `tokens.creator_address`

### 2. Pump.fun Price Monitor Output
- `mint` → Lookup `tokens.id` via `mint_address`
- `bondingCurve` → `pools.bonding_curve_address`
- `virtualSolReserves` → `pools.virtual_sol_reserves`
- `virtualTokenReserves` → `pools.virtual_token_reserves`
- `bondingCurveProgress` → `pools.bonding_curve_progress`
- `priceInSol` → `pools.latest_price`

### 3. Pump.fun Transaction Monitor Output
- `timestamp` → `transactions.block_time`
- `signature` → `transactions.signature`
- `type` → `transactions.type`
- `user` → `transactions.user_address`
- `solAmount` → `transactions.sol_amount`
- `tokenAmount` → `transactions.token_amount`
- `pricePerToken` → `transactions.price_per_token`

### 4. Raydium Launchpad Monitor Output
- `poolState` → `pools.pool_address`
- `baseTokenMint` → `tokens.mint_address`, `pools.base_mint`
- `quoteTokenMint` → `pools.quote_mint`
- `initialPrice` → `pools.initial_price`
- `initialLiquidity` → `pools.initial_quote_liquidity`

## Planned Tables (Not Yet Implemented)

The following tables are designed but not yet included in migrations:

- **holder_snapshots**: Token holder distribution tracking
- **top_holders**: Individual wallet tracking for major holders
- **social_metrics**: Twitter/Telegram/Discord metrics from TweetScout
- **trading_signals**: Buy/sell signals generated by the ML system
- **system_metrics**: Performance and health monitoring
- **price_candles_5m**, **price_candles_1h**, **price_candles_1d**: Additional time aggregations

## Migration Strategy

Run migrations in order:
1. 001_create_tokens_table.sql
2. 002_create_pools_table.sql
3. 003_create_transactions_hypertable.sql
4. 004_create_price_aggregates.sql
5. 005_create_price_continuous_aggregate.sql (outside transaction)
6. 006_add_latest_price_to_pools.sql
7. 007_create_token_scores_table.sql
8. 008_create_sol_usd_prices.sql
9. 009_create_sol_usd_continuous_aggregate.sql (outside transaction)
10. 010_add_usd_price_enhancements.sql
11. 011_fix_token_stats_function.sql
12. 012_fix_materialized_view_refresh.sql
13. 013_fix_backfill_function.sql

See `src/database/migrations/README.md` for detailed migration instructions.