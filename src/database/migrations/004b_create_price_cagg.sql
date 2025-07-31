-- This file must be run separately from the main migration
-- as CREATE MATERIALIZED VIEW WITH DATA cannot run inside a transaction

-- Create continuous aggregate from transactions
CREATE MATERIALIZED VIEW IF NOT EXISTS price_candles_1m_cagg
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

-- Note: Comments on continuous aggregates are not supported in TimescaleDB