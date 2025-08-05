# Database Implementation Plan

## Overview
This plan provides a step-by-step implementation of the database schema with testable checkpoints at each stage. Each session is designed to be completed independently with validation against real blockchain data.

## Prerequisites
- PostgreSQL 15+ installed
- TimescaleDB extension installed
- Access to Solana RPC endpoint for validation
- Existing monitors running (Raydium Launchpad, Pump.fun)

## Current Implementation Status

### Completed Migrations
All core database functionality has been implemented through 13 migrations:

1. **001_create_tokens_table.sql** - Token master data ✅
2. **002_create_pools_table.sql** - Pool/bonding curve data ✅
3. **003_create_transactions_hypertable.sql** - Time-series transactions ✅
4. **004_create_price_aggregates.sql** - Price candle infrastructure ✅
5. **005_create_price_continuous_aggregate.sql** - Continuous price aggregates ✅
6. **006_add_latest_price_to_pools.sql** - Latest price tracking ✅
7. **007_create_token_scores_table.sql** - Scoring system foundation ✅
8. **008_create_sol_usd_prices.sql** - SOL/USD price tracking ✅
9. **009_create_sol_usd_continuous_aggregate.sql** - SOL/USD aggregates ✅
10. **010_add_usd_price_enhancements.sql** - USD value calculations ✅
11. **011_fix_token_stats_function.sql** - Function fixes ✅
12. **012_fix_materialized_view_refresh.sql** - View refresh fixes ✅
13. **013_fix_backfill_function.sql** - Backfill improvements ✅

### Running All Migrations

```bash
# Quick setup - runs all migrations in order
npm run db:setup

# Or manually run each migration
psql -U your_user -d megatron_v2 -f src/database/migrations/001_create_tokens_table.sql
psql -U your_user -d megatron_v2 -f src/database/migrations/002_create_pools_table.sql
# ... continue for all migrations

# Note: Migrations 005 and 009 must be run outside transactions
psql -U your_user -d megatron_v2 -c "$(cat src/database/migrations/005_create_price_continuous_aggregate.sql)"
psql -U your_user -d megatron_v2 -c "$(cat src/database/migrations/009_create_sol_usd_continuous_aggregate.sql)"
```

---

## Session 1: Core Database Setup & Token Tables ✅ COMPLETED

### Implementation Status
- ✅ Database created with TimescaleDB extension
- ✅ Tokens table created via `001_create_tokens_table.sql`
- ✅ Monitor integration saves new tokens automatically
- ✅ Both Pump.fun and Raydium tokens captured

### Current State
- 30+ tokens captured from live monitors
- Automatic token saving on mint detection
- No duplicate mint addresses
- All blockchain data validated

### Usage
```bash
# Tokens are automatically saved when running monitors
npm run pfmonitor:mint        # Pump.fun new tokens
npm run rlmonitor:mint        # Raydium new tokens
```

---

## Session 2: Pool Data & Relationships ✅ COMPLETED

### Implementation Status
- ✅ Pools table created via `002_create_pools_table.sql`
- ✅ Pool operations module with transactional integrity
- ✅ Monitor integration saves pools automatically
- ✅ Latest price column added via `006_add_latest_price_to_pools.sql`

### Key Features Implemented
- Automatic pool creation on token mint
- Virtual/real reserve tracking for Pump.fun
- Bonding curve progress calculation
- Latest price updates from price monitor

### Current State
- All new tokens have associated pools
- Pool addresses stored correctly per platform
- Price updates captured in real-time

---

## Session 3: Transaction Tables & Time-Series Setup ✅ COMPLETED

### Implementation Status
- ✅ Transaction hypertable created via `003_create_transactions_hypertable.sql`
- ✅ Automatic normalization triggers
- ✅ Compression and retention policies configured
- ✅ All monitors save transactions in real-time

### Performance Achieved
- **Insertion Rate**: 19,455 transactions/second
- **Query Performance**: 2-10ms for recent data
- **Storage**: Automatic partitioning and compression active
- **Volume**: 50,000+ transactions captured and growing

### Usage
```bash
# Transactions are automatically saved when running monitors
npm run pfmonitor:transaction  # Pump.fun transactions
npm run rlmonitor:trans       # Raydium transactions
```

---

## Session 4: Price Aggregates & Continuous Views ✅ COMPLETED

### Implementation Status
- ✅ Price candles table created via `004_create_price_aggregates.sql`
- ✅ Continuous aggregate created via `005_create_price_continuous_aggregate.sql`
- ✅ Helper functions for price analytics
- ✅ High volume tokens view
- ✅ Automatic refresh policy (every minute)

### Key Features
- 1-minute price candles from transaction data
- Automatic OHLCV calculation
- Volume and trader count tracking
- Efficient time-series queries

### Testing
```sql
-- View recent price data
SELECT * FROM price_candles_1m_cagg 
WHERE token_id = (SELECT id FROM tokens LIMIT 1)
ORDER BY bucket DESC LIMIT 10;

-- Check high volume tokens
SELECT * FROM high_volume_tokens;
```

---

## Session 5: SOL/USD Price Integration ✅ COMPLETED

### Implementation Status
- ✅ SOL/USD price table via `008_create_sol_usd_prices.sql`
- ✅ Continuous aggregate via `009_create_sol_usd_continuous_aggregate.sql`
- ✅ USD enhancement columns via `010_add_usd_price_enhancements.sql`
- ✅ Functions for USD calculations

### Key Features
- Historical SOL/USD price tracking
- Multiple price sources support (Pyth, Jupiter, etc.)
- Automatic USD value calculation for transactions
- USD-denominated price candles

### Functions Available
- `get_sol_usd_price(timestamp)` - Get SOL price at specific time
- `get_latest_sol_usd_price()` - Get current SOL price
- `update_price_candle_usd_values()` - Backfill USD values
- `get_token_stats_with_usd()` - Token stats in USD

---

## Session 6: Token Scoring System ✅ PARTIALLY COMPLETED

### Implementation Status
- ✅ Token scores table via `007_create_token_scores_table.sql`
- ✅ Calculate technical score function
- ⏳ ML integration pending
- ⏳ Social score integration pending

### Current Structure
```sql
-- Token scores table ready
CREATE TABLE token_scores (
    token_address VARCHAR(66) PRIMARY KEY,
    total_score INTEGER NOT NULL DEFAULT 0,
    technical_score INTEGER NOT NULL DEFAULT 0,
    holder_score INTEGER NOT NULL DEFAULT 0,
    social_score INTEGER NOT NULL DEFAULT 0,
    graduation_probability DECIMAL(5,2) DEFAULT 0,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Next Steps
1. Implement holder snapshot collection
2. Integrate TweetScout for social scores
3. Build ML model for graduation probability
4. Create scoring calculation pipeline

---

## Session 7: Performance Optimization ✅ COMPLETED

### Implementation Status
- ✅ All necessary indexes created
- ✅ Compression policies active (7-day delay)
- ✅ Retention policies configured (90 days)
- ✅ Continuous aggregates with refresh policies
- ✅ Query performance optimized

### Performance Metrics
- Transaction insertion: 19,455/second
- Price queries: 2-10ms
- Compression ratio: >5:1 achieved
- Storage growth: Sustainable with policies

---

## Pending Implementation

### 1. Holder Analytics (Not Yet Implemented)
```sql
-- Requires separate data collection pipeline
CREATE TABLE holder_snapshots (
    -- Token holder distribution over time
);

CREATE TABLE top_holders (
    -- Track major wallet movements
);
```

### 2. Social Metrics Integration
```sql
-- Requires TweetScout API integration
CREATE TABLE social_metrics (
    -- Twitter, Telegram, Discord metrics
);
```

### 3. Trading Signals System
```sql
-- Requires ML model and scoring system completion
CREATE TABLE trading_signals (
    -- Buy/sell signal generation
);
```

### 4. Redis Cache Layer
- Design complete but not implemented
- Will cache hot token data
- Reduce database load for frequent queries

---

## Maintenance and Monitoring

### Daily Tasks
```bash
# Check compression status
psql -d megatron_v2 -c "SELECT * FROM timescaledb_information.compressed_chunk_stats ORDER BY compression_ratio DESC LIMIT 10;"

# Monitor table sizes
psql -d megatron_v2 -c "SELECT tablename, pg_size_pretty(pg_total_relation_size(tablename::regclass)) FROM pg_tables WHERE schemaname = 'public' ORDER BY pg_total_relation_size(tablename::regclass) DESC;"
```

### Weekly Tasks
```bash
# Analyze query performance
psql -d megatron_v2 -c "SELECT query, calls, mean_exec_time FROM pg_stat_statements WHERE query LIKE '%transactions%' ORDER BY mean_exec_time DESC LIMIT 10;"

# Update table statistics
psql -d megatron_v2 -c "ANALYZE;"
```

### System Health Check
```sql
-- Overview dashboard
SELECT 
  (SELECT COUNT(*) FROM tokens WHERE created_at > NOW() - INTERVAL '1 hour') as new_tokens_1h,
  (SELECT COUNT(*) FROM transactions WHERE block_time > NOW() - INTERVAL '1 hour') as transactions_1h,
  (SELECT COUNT(DISTINCT token_id) FROM transactions WHERE block_time > NOW() - INTERVAL '1 hour') as active_tokens_1h,
  (SELECT pg_size_pretty(pg_database_size('megatron_v2'))) as database_size;

-- Monitor performance by platform
SELECT 
  t.platform,
  COUNT(DISTINCT t.id) as total_tokens,
  COUNT(DISTINCT CASE WHEN t.created_at > NOW() - INTERVAL '24 hours' THEN t.id END) as new_24h,
  COUNT(DISTINCT tx.token_id) as tokens_with_transactions,
  SUM(CASE WHEN p.bonding_curve_progress > 50 THEN 1 ELSE 0 END) as high_progress_tokens
FROM tokens t
LEFT JOIN pools p ON t.id = p.token_id
LEFT JOIN transactions tx ON t.id = tx.token_id
GROUP BY t.platform;
```

---

## Next Development Priorities

1. **Complete Scoring System**
   - Implement holder distribution tracking
   - Integrate social metrics
   - Build ML graduation prediction model

2. **Add Redis Cache**
   - Implement hot data caching
   - Reduce database load
   - Improve API response times

3. **Build Trading Engine**
   - Signal generation from scores
   - Entry/exit logic
   - Performance tracking

4. **Create Monitoring Dashboard**
   - Real-time metrics visualization
   - Alert system for high-score tokens
   - Performance analytics

## Conclusion

The core database infrastructure is fully operational with:
- ✅ All essential tables and functions
- ✅ Real-time data ingestion from monitors
- ✅ Efficient time-series storage with TimescaleDB
- ✅ USD price tracking and calculations
- ✅ Performance optimization with compression and indexing

The system is ready for the next phase: implementing the ML-driven scoring system and trading signal generation.