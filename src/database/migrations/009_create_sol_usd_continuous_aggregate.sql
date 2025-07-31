-- Migration: 009_create_sol_usd_continuous_aggregate
-- Description: Creates continuous aggregate for SOL/USD price candles
-- Dependencies: 008_create_sol_usd_prices
-- IMPORTANT: Must be run outside a transaction

-- Drop if exists (for development)
DROP MATERIALIZED VIEW IF EXISTS sol_usd_candles_1m CASCADE;

-- Create continuous aggregate
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

-- Add continuous aggregate policy
SELECT add_continuous_aggregate_policy('sol_usd_candles_1m',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '10 minutes',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE);

-- Grant permissions
GRANT SELECT ON sol_usd_candles_1m TO PUBLIC;