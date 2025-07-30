# Database Implementation Plan

## Overview
This plan provides a step-by-step implementation of the database schema with testable checkpoints at each stage. Each session is designed to be completed independently with validation against real blockchain data.

## Prerequisites
- PostgreSQL 15+ installed
- TimescaleDB extension installed
- Redis server running
- Access to Solana RPC endpoint for validation
- Existing monitors running (Raydium Launchpad, Pump.fun)

## Session 1: Core Database Setup & Token Tables

### Goals
- Set up database and TimescaleDB
- Create token master data tables
- Test with real token creation events

### Implementation Steps

```bash
# 1. Create database
createdb megatron_v2

# 2. Connect and enable extensions
psql -d megatron_v2
```

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Create tokens table
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

-- Create indexes
CREATE INDEX idx_tokens_mint_address ON tokens(mint_address);
CREATE INDEX idx_tokens_platform ON tokens(platform);
CREATE INDEX idx_tokens_creation_timestamp ON tokens(creation_timestamp);
```

### Testing & Validation

1. **Create test insertion script** (`src/database/test-token-insert.ts`):
```typescript
import { Pool } from 'pg';

const pool = new Pool({
  database: 'megatron_v2',
  // connection config
});

async function insertTestToken() {
  // Use real data from monitor output
  const testToken = {
    mint_address: 'ACTUAL_MINT_FROM_MONITOR',
    symbol: 'TEST',
    name: 'Test Token',
    platform: 'raydium_launchpad',
    creation_signature: 'ACTUAL_SIGNATURE',
    creation_timestamp: new Date(),
    creator_address: 'ACTUAL_CREATOR'
  };
  
  const result = await pool.query(
    `INSERT INTO tokens (mint_address, symbol, name, platform, creation_signature, creation_timestamp, creator_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [testToken.mint_address, testToken.symbol, testToken.name, testToken.platform, 
     testToken.creation_signature, testToken.creation_timestamp, testToken.creator_address]
  );
  
  console.log('Inserted token:', result.rows[0]);
}
```

2. **Validation queries**:
```sql
-- Verify token insertion
SELECT * FROM tokens WHERE creation_timestamp > NOW() - INTERVAL '1 hour';

-- Check for duplicates
SELECT mint_address, COUNT(*) FROM tokens GROUP BY mint_address HAVING COUNT(*) > 1;

-- Verify platform distribution
SELECT platform, COUNT(*) FROM tokens GROUP BY platform;
```

3. **Cross-reference with blockchain**:
- Use Solana Explorer to verify mint addresses
- Compare creation_signature with actual transaction
- Validate creator_address matches on-chain data

### Success Criteria
- [ ] Successfully insert 10 real tokens from monitors
- [ ] No duplicate mint_addresses
- [ ] All blockchain data matches database records

---

## Session 2: Pool Data & Relationships

### Goals
- Create pool tables
- Link pools to tokens
- Store bonding curve and liquidity data

### Implementation Steps

```sql
-- Create pools table
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

-- Create indexes
CREATE INDEX idx_pools_token_id ON pools(token_id);
CREATE INDEX idx_pools_platform ON pools(platform);
```

### Testing & Validation

1. **Pool insertion with token relationship**:
```typescript
async function insertPoolWithToken(poolData: any, tokenMint: string) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get token ID
    const tokenResult = await client.query(
      'SELECT id FROM tokens WHERE mint_address = $1',
      [tokenMint]
    );
    
    if (!tokenResult.rows[0]) {
      throw new Error('Token not found');
    }
    
    // Insert pool
    const poolResult = await client.query(
      `INSERT INTO pools (pool_address, token_id, base_mint, quote_mint, platform, initial_price)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [poolData.pool_address, tokenResult.rows[0].id, poolData.base_mint, 
       poolData.quote_mint, poolData.platform, poolData.initial_price]
    );
    
    await client.query('COMMIT');
    return poolResult.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

2. **Validation queries**:
```sql
-- Verify pool-token relationships
SELECT t.mint_address, t.symbol, p.pool_address, p.initial_price
FROM tokens t
JOIN pools p ON t.id = p.token_id
ORDER BY p.created_at DESC LIMIT 10;

-- Check for orphaned pools
SELECT * FROM pools WHERE token_id NOT IN (SELECT id FROM tokens);

-- Verify bonding curve data for Pump.fun
SELECT bonding_curve_progress, real_sol_reserves, real_token_reserves
FROM pools 
WHERE platform = 'pumpfun' AND bonding_curve_progress IS NOT NULL;
```

### Success Criteria
- [ ] All pools have valid token relationships
- [ ] Pool addresses match blockchain data
- [ ] Initial prices calculate correctly from reserves

---

## Session 3: Transaction Tables & Time-Series Setup ✅ COMPLETED

### Goals
- ✅ Create transaction hypertables
- ✅ Implement efficient time-series storage
- ✅ Test with high-volume transaction data
- ✅ Integrate with live monitors for real-time data capture

### Implementation Completed

1. **Transaction Hypertable Created** (`migrations/003_create_transactions_hypertable.sql`):
   - Composite primary key (signature, block_time) for TimescaleDB compatibility
   - Automatic calculation triggers for normalized amounts
   - Optimized indexes for common query patterns
   - Compression (7 days) and retention (90 days) policies

2. **Transaction Operations Module** (`transaction-operations.ts`):
   - Efficient bulk insertion with PostgreSQL parameter limit handling
   - Single transaction insertion with duplicate handling
   - Performance monitoring and hypertable health checks
   - Volume statistics and query methods

3. **Monitor Integration** (`transaction-monitor-integration.ts`):
   - Universal integration module for all monitors
   - Token/pool lookup with caching
   - Automatic conversion from monitor format to database format
   - Error handling for missing tokens/pools

4. **Monitor Updates**:
   - ✅ Raydium Launchpad transaction monitor saves all buy/sell transactions
   - ✅ Pump.fun transaction monitor saves all buy/sell transactions
   - Both monitors show save status in console output

### Performance Results

- **Insertion Rate**: 19,455 transactions/second achieved
- **Query Performance**: 2-10ms for recent data queries
- **Bulk Processing**: Handles 2,000 transactions per batch efficiently
- **Storage**: Automatic partitioning and compression working correctly

### Usage

```bash
# Setup transaction table
npm run db:setup:transactions

# Run monitors to save transactions
npm run rlmonitor:trans      # Raydium transactions
npm run pfmonitor:transaction # Pump.fun transactions

# Test transaction operations
npm run db:test:transactions
npm run db:perf:transactions
```

### Database State
- 23+ Raydium tokens captured
- 8+ Pump.fun tokens captured
- 13,000+ transactions saved and growing
- Automatic time-series partitioning active

### Success Criteria Achieved
- ✅ Insert 10,000+ transactions without errors (tested with 50,000+)
- ✅ Query performance <100ms for recent data (achieved 2-10ms)
- ✅ Signatures match blockchain transactions
- ✅ Real-time transaction saving from live monitors

---

## Session 4: Price Aggregates & Continuous Views

### Goals
- Create price candle tables
- Set up continuous aggregates
- Validate price calculations

### Implementation Steps

```sql
-- Create 1-minute candles
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

-- Create continuous aggregate from transactions
CREATE MATERIALIZED VIEW price_candles_1m_cagg
WITH (timescaledb.continuous) AS
SELECT
    token_id,
    time_bucket('1 minute', block_time) AS bucket,
    first(price_per_token, block_time) AS open,
    max(price_per_token) AS high,
    min(price_per_token) AS low,
    last(price_per_token, block_time) AS close,
    sum(token_amount) FILTER (WHERE type IN ('buy', 'sell')) AS volume_token,
    sum(sol_amount) FILTER (WHERE type IN ('buy', 'sell')) AS volume_sol,
    count(*) AS trade_count,
    count(DISTINCT user_address) FILTER (WHERE type = 'buy') AS buyer_count,
    count(DISTINCT user_address) FILTER (WHERE type = 'sell') AS seller_count
FROM transactions
GROUP BY token_id, time_bucket('1 minute', block_time);

-- Add refresh policy
SELECT add_continuous_aggregate_policy('price_candles_1m_cagg',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
```

### Testing & Validation

1. **Price accuracy test**:
```typescript
async function validatePriceCandles(tokenId: string, timeRange: string) {
  // Get raw transactions
  const rawTxQuery = `
    SELECT block_time, price_per_token, type
    FROM transactions
    WHERE token_id = $1 
      AND block_time > NOW() - INTERVAL '${timeRange}'
    ORDER BY block_time
  `;
  
  // Get aggregated candles
  const candleQuery = `
    SELECT bucket, open, high, low, close, volume_sol
    FROM price_candles_1m_cagg
    WHERE token_id = $1
      AND bucket > NOW() - INTERVAL '${timeRange}'
    ORDER BY bucket
  `;
  
  const rawTx = await pool.query(rawTxQuery, [tokenId]);
  const candles = await pool.query(candleQuery, [tokenId]);
  
  // Validate OHLC values match raw data
  // Compare volumes
  // Check for missing buckets
}
```

2. **Validation queries**:
```sql
-- Compare raw vs aggregated data
WITH raw_calc AS (
  SELECT 
    time_bucket('1 minute', block_time) as minute,
    COUNT(*) as tx_count,
    MIN(price_per_token) as min_price,
    MAX(price_per_token) as max_price
  FROM transactions
  WHERE token_id = 'YOUR_TOKEN_ID'
    AND block_time > NOW() - INTERVAL '1 hour'
  GROUP BY minute
)
SELECT 
  r.minute,
  r.tx_count as raw_count,
  c.trade_count as agg_count,
  r.min_price as raw_min,
  c.low as agg_min,
  ABS(r.min_price - c.low) as price_diff
FROM raw_calc r
LEFT JOIN price_candles_1m_cagg c 
  ON c.bucket = r.minute AND c.token_id = 'YOUR_TOKEN_ID'
ORDER BY r.minute DESC;
```

### Success Criteria
- [ ] Continuous aggregates refresh automatically
- [ ] OHLC values match raw transaction data
- [ ] No missing time buckets for active tokens

---

## Session 5: Scoring System & Analytics

### Goals
- Implement holder tracking tables
- Create scoring calculation tables
- Test scoring accuracy

### Implementation Steps

```sql
-- Create holder snapshots
CREATE TABLE holder_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    snapshot_time TIMESTAMPTZ NOT NULL,
    total_holders INTEGER NOT NULL,
    
    -- Distribution metrics
    top_10_concentration NUMERIC(5,2),
    top_25_concentration NUMERIC(5,2),
    gini_coefficient NUMERIC(5,4),
    
    -- Holder categories
    holders_1_100 INTEGER DEFAULT 0,
    holders_100_1k INTEGER DEFAULT 0,
    holders_1k_10k INTEGER DEFAULT 0,
    holders_10k_plus INTEGER DEFAULT 0,
    
    raw_distribution JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create token scores
CREATE TABLE token_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    calculated_at TIMESTAMPTZ NOT NULL,
    
    -- Main scores (out of 333 each)
    technical_score INTEGER NOT NULL CHECK (technical_score >= 0 AND technical_score <= 333),
    holder_score INTEGER NOT NULL CHECK (holder_score >= 0 AND holder_score <= 333),
    social_score INTEGER NOT NULL CHECK (social_score >= 0 AND social_score <= 333),
    total_score INTEGER GENERATED ALWAYS AS (technical_score + holder_score + social_score) STORED,
    
    -- Breakdowns
    liquidity_score INTEGER,
    trading_score INTEGER,
    distribution_score INTEGER,
    
    score_details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_token_scores_token_time ON token_scores(token_id, calculated_at DESC);
CREATE INDEX idx_token_scores_total ON token_scores(total_score DESC);
```

### Testing & Validation

1. **Score calculation test**:
```typescript
async function calculateAndValidateScore(tokenId: string) {
  // Calculate technical score based on liquidity and trading metrics
  const technicalQuery = `
    WITH pool_data AS (
      SELECT initial_price, initial_quote_liquidity
      FROM pools WHERE token_id = $1
    ),
    trading_data AS (
      SELECT 
        COUNT(*) as trade_count,
        SUM(volume_sol) as total_volume,
        COUNT(DISTINCT user_address) as unique_traders
      FROM transactions
      WHERE token_id = $1 AND block_time > NOW() - INTERVAL '24 hours'
    )
    SELECT 
      -- Score calculations here
      LEAST(333, (p.initial_quote_liquidity / 1000000000 * 10)::INT) as liquidity_score,
      LEAST(333, (t.trade_count * 2)::INT) as trading_score
    FROM pool_data p, trading_data t
  `;
  
  const result = await pool.query(technicalQuery, [tokenId]);
  // Insert score and validate
}
```

2. **Validation queries**:
```sql
-- Verify score calculations
SELECT 
  t.symbol,
  s.technical_score,
  s.holder_score,
  s.social_score,
  s.total_score,
  s.calculated_at
FROM token_scores s
JOIN tokens t ON s.token_id = t.id
WHERE s.calculated_at > NOW() - INTERVAL '1 hour'
ORDER BY s.total_score DESC;

-- Check score distribution
SELECT 
  CASE 
    WHEN total_score < 300 THEN '0-299'
    WHEN total_score < 600 THEN '300-599'
    WHEN total_score < 800 THEN '600-799'
    ELSE '800+'
  END as score_range,
  COUNT(*) as token_count
FROM token_scores
WHERE calculated_at > NOW() - INTERVAL '24 hours'
GROUP BY score_range;
```

### Success Criteria
- [ ] Scores calculate consistently
- [ ] Score components sum correctly
- [ ] Historical scores track token performance

---

## Session 6: Redis Cache & Performance Testing

### Goals
- Set up Redis caching layer
- Implement cache synchronization
- Load test the complete system

### Implementation Steps

1. **Redis cache setup**:
```typescript
import Redis from 'ioredis';

const redis = new Redis();

// Cache current scores
async function cacheTokenScore(tokenId: string, score: any) {
  const key = `token:score:${tokenId}`;
  const ttl = 300; // 5 minutes
  
  await redis.setex(key, ttl, JSON.stringify({
    technical_score: score.technical_score,
    holder_score: score.holder_score,
    social_score: score.social_score,
    total_score: score.total_score,
    last_updated: new Date().toISOString()
  }));
}

// Cache price data
async function cachePriceData(tokenId: string, priceData: any) {
  const key = `price:current:${tokenId}`;
  const ttl = 30; // 30 seconds
  
  await redis.setex(key, ttl, JSON.stringify({
    price: priceData.price,
    volume_1h: priceData.volume_1h,
    change_1h: priceData.change_1h,
    last_trade: priceData.last_trade
  }));
}

// Hot tokens sorted set
async function updateHotTokens(tokenId: string, score: number) {
  await redis.zadd('tokens:hot', score, tokenId);
  await redis.expire('tokens:hot', 60); // 1 minute TTL
}
```

2. **Cache synchronization**:
```typescript
async function syncDatabaseToCache() {
  // Get recent high-scoring tokens
  const hotTokensQuery = `
    SELECT t.id, t.mint_address, s.total_score
    FROM tokens t
    JOIN token_scores s ON t.id = s.token_id
    WHERE s.calculated_at > NOW() - INTERVAL '1 hour'
    ORDER BY s.total_score DESC
    LIMIT 100
  `;
  
  const result = await pool.query(hotTokensQuery);
  
  // Update Redis
  const pipeline = redis.pipeline();
  result.rows.forEach(row => {
    pipeline.zadd('tokens:hot', row.total_score, row.id);
  });
  await pipeline.exec();
}
```

### Load Testing

1. **Performance test script**:
```typescript
async function loadTest() {
  const startTime = Date.now();
  const promises = [];
  
  // Simulate 1000 concurrent operations
  for (let i = 0; i < 1000; i++) {
    promises.push(
      // Mix of operations
      i % 4 === 0 ? insertTransaction() :
      i % 4 === 1 ? queryPriceData() :
      i % 4 === 2 ? calculateScore() :
      getCachedData()
    );
  }
  
  await Promise.all(promises);
  
  const duration = Date.now() - startTime;
  console.log(`Completed 1000 operations in ${duration}ms`);
  console.log(`Average: ${duration / 1000}ms per operation`);
}
```

2. **Validation queries**:
```sql
-- Check database performance
SELECT 
  query,
  calls,
  mean_exec_time,
  max_exec_time
FROM pg_stat_statements
WHERE query LIKE '%transactions%' OR query LIKE '%token_scores%'
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Monitor table sizes
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

### Success Criteria
- [ ] Database handles 1000+ operations/second
- [ ] Cache hit rate >80% for hot data
- [ ] Query latency <100ms for recent data

---

## Session 7: Data Retention & Maintenance

### Goals
- Set up retention policies
- Configure compression
- Test data lifecycle

### Implementation Steps

```sql
-- Add retention policies
SELECT add_retention_policy('transactions', INTERVAL '90 days');
SELECT add_retention_policy('price_candles_1m', INTERVAL '7 days');

-- Add compression policies
SELECT add_compression_policy('transactions', INTERVAL '7 days');
SELECT add_compression_policy('price_candles_1m', INTERVAL '1 day');

-- Create maintenance procedures
CREATE OR REPLACE FUNCTION cleanup_old_scores()
RETURNS void AS $$
BEGIN
  DELETE FROM token_scores 
  WHERE calculated_at < NOW() - INTERVAL '30 days'
    AND token_id IN (
      SELECT id FROM tokens WHERE is_graduated = false
    );
END;
$$ LANGUAGE plpgsql;

-- Schedule maintenance
SELECT cron.schedule('cleanup-scores', '0 2 * * *', 'SELECT cleanup_old_scores()');
```

### Testing & Validation

1. **Verify policies**:
```sql
-- Check retention policies
SELECT * FROM timescaledb_information.retention_policies;

-- Check compression status
SELECT 
  hypertable_name,
  chunk_name,
  before_compression_total_bytes,
  after_compression_total_bytes,
  compression_ratio
FROM timescaledb_information.compressed_chunk_stats
ORDER BY compression_ratio DESC;
```

### Success Criteria
- [ ] Old data automatically removed
- [ ] Compression ratio >5:1
- [ ] Storage growth sustainable

---

## Final Integration Test

### Complete System Test
1. Run all monitors for 1 hour
2. Verify data flow: Monitor → Database → Cache
3. Check data consistency across all tables
4. Validate against blockchain data
5. Performance benchmarks meet requirements

### Monitoring Dashboard Queries
```sql
-- System health overview
SELECT 
  (SELECT COUNT(*) FROM tokens WHERE created_at > NOW() - INTERVAL '1 hour') as new_tokens,
  (SELECT COUNT(*) FROM transactions WHERE block_time > NOW() - INTERVAL '1 hour') as recent_transactions,
  (SELECT COUNT(*) FROM token_scores WHERE calculated_at > NOW() - INTERVAL '1 hour') as scores_calculated,
  (SELECT pg_database_size('megatron_v2')) as database_size;

-- Token pipeline status
SELECT 
  t.platform,
  COUNT(DISTINCT t.id) as token_count,
  COUNT(DISTINCT p.id) as pool_count,
  SUM(CASE WHEN s.total_score > 700 THEN 1 ELSE 0 END) as high_score_tokens
FROM tokens t
LEFT JOIN pools p ON t.id = p.token_id
LEFT JOIN token_scores s ON t.id = s.token_id
WHERE t.created_at > NOW() - INTERVAL '24 hours'
GROUP BY t.platform;
```

## Next Steps After Implementation

1. **Performance Tuning**
   - Analyze slow queries
   - Add missing indexes
   - Optimize continuous aggregates

2. **Monitoring Setup**
   - Prometheus metrics
   - Grafana dashboards
   - Alert configurations

3. **Backup Strategy**
   - Automated backups
   - Point-in-time recovery
   - Disaster recovery plan