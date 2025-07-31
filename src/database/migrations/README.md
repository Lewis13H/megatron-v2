# Database Migrations

This directory contains all database migrations for the Megatron V2 project. Migrations must be run in order.

## Migration Order

1. **001_create_tokens_table.sql**
   - Creates the base tokens table
   - Dependencies: None (requires TimescaleDB extension)
   - Tables: `tokens`

2. **002_create_pools_table.sql**
   - Creates pools table for liquidity pools
   - Dependencies: `001_create_tokens_table`
   - Tables: `pools`
   - Foreign Keys: `pools.token_id -> tokens.id`

3. **003_create_transactions_hypertable.sql**
   - Creates transactions hypertable for time-series data
   - Dependencies: `001_create_tokens_table`, `002_create_pools_table`
   - Tables: `transactions` (hypertable)
   - Views: `recent_transactions`
   - Functions: `calculate_normalized_amounts()`, `get_transaction_volume_stats()`

4. **004_create_price_aggregates.sql**
   - Creates price candles table and analytics functions
   - Dependencies: `003_create_transactions_hypertable`
   - Tables: `price_candles_1m` (hypertable)
   - Functions: `get_latest_price()`, `get_price_change()`
   - Views: `high_volume_tokens`

5. **005_create_price_continuous_aggregate.sql**
   - Creates continuous aggregate for price data
   - Dependencies: `004_create_price_aggregates`
   - **IMPORTANT**: Must be run outside a transaction
   - Continuous Aggregates: `price_candles_1m_cagg`
   - Updates functions to use the continuous aggregate

6. **006_add_latest_price_to_pools.sql**
   - Adds latest_price column to pools table
   - Dependencies: `002_create_pools_table`
   - Columns: `pools.latest_price`

7. **007_create_token_scores_table.sql**
   - Creates token scoring system tables
   - Dependencies: `001_create_tokens_table`
   - Tables: `token_scores`
   - Functions: `calculate_technical_score()`

8. **008_create_sol_usd_prices.sql**
   - Creates SOL/USD price tracking infrastructure
   - Dependencies: None (requires TimescaleDB)
   - Tables: `sol_usd_prices` (hypertable)
   - Functions: `get_sol_usd_price()`, `get_latest_sol_usd_price()`

9. **009_create_sol_usd_continuous_aggregate.sql**
   - Creates continuous aggregate for SOL/USD prices
   - Dependencies: `008_create_sol_usd_prices`
   - **IMPORTANT**: Must be run outside a transaction
   - Continuous Aggregates: `sol_usd_candles_1m`

10. **010_add_usd_price_enhancements.sql**
    - Adds USD price columns and calculations
    - Dependencies: `004_create_price_aggregates`, `008_create_sol_usd_prices`
    - Columns: Adds USD columns to `price_candles_1m` and `transactions`
    - Functions: `update_price_candle_usd_values()`, `backfill_transaction_usd_values()`
    - Views: `top_tokens_by_usd_volume`

11. **011_fix_token_stats_function.sql**
    - Fixes ambiguous column references
    - Dependencies: `010_add_usd_price_enhancements`
    - Functions: Updates `get_token_stats_with_usd()`

12. **012_fix_materialized_view_refresh.sql**
    - Fixes materialized view refresh functions
    - Dependencies: `010_add_usd_price_enhancements`
    - Functions: `refresh_top_tokens_usd()`, `refresh_top_tokens_usd_concurrent()`

13. **013_fix_backfill_function.sql**
    - Fixes backfill function to use correct column
    - Dependencies: `010_add_usd_price_enhancements`
    - Functions: Updates `backfill_transaction_usd_values()`

## Running Migrations

### Run all migrations in order:
```bash
# Connect to your database
psql -U your_user -d your_database

# Run each migration file in order
\i src/database/migrations/001_create_tokens_table.sql
\i src/database/migrations/002_create_pools_table.sql
\i src/database/migrations/003_create_transactions_hypertable.sql
\i src/database/migrations/004_create_price_aggregates.sql

# This one must be run separately (not in a transaction)
\i src/database/migrations/005_create_price_continuous_aggregate.sql

\i src/database/migrations/006_add_latest_price_to_pools.sql
\i src/database/migrations/007_create_token_scores_table.sql
\i src/database/migrations/008_create_sol_usd_prices.sql

# This one must be run separately (not in a transaction)
\i src/database/migrations/009_create_sol_usd_continuous_aggregate.sql

\i src/database/migrations/010_add_usd_price_enhancements.sql
\i src/database/migrations/011_fix_token_stats_function.sql
\i src/database/migrations/012_fix_materialized_view_refresh.sql
\i src/database/migrations/013_fix_backfill_function.sql
```

### Using npm scripts:
```bash
# Set up all tables
npm run db:setup
```

## Migration Guidelines

1. **Naming Convention**: `XXX_descriptive_name.sql` where XXX is a zero-padded sequential number
2. **Header Format**: Each migration must start with:
   ```sql
   -- Migration: XXX_migration_name
   -- Description: Brief description of what this migration does
   -- Dependencies: List of migrations this depends on
   ```
3. **Idempotency**: Migrations should use `IF NOT EXISTS` where possible
4. **Comments**: Add table and column comments for documentation
5. **Transactions**: Most migrations can run in transactions, except continuous aggregates

## Schema Overview

- **tokens**: Base table for all token metadata
- **pools**: Liquidity pool information for both Pump.fun and Raydium
- **transactions**: Time-series data for all token transactions
- **price_candles_1m**: 1-minute price candles
- **price_candles_1m_cagg**: Continuous aggregate for efficient price queries
- **token_scores**: ML-based scoring for tokens (999-point system)