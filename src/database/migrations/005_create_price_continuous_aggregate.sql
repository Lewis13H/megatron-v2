-- Migration: 005_create_price_continuous_aggregate
-- Description: Creates continuous aggregate for price candles (must run outside transaction)
-- Dependencies: 004_create_price_aggregates
-- IMPORTANT: This migration must be run separately as continuous aggregates cannot be created in transactions

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

-- Add refresh policy to keep aggregate up-to-date
-- Refresh every 1 minute with 2 minute lag
SELECT add_continuous_aggregate_policy('price_candles_1m_cagg',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '2 minutes',
    schedule_interval => INTERVAL '1 minute');

-- Update get_latest_price function to use continuous aggregate
CREATE OR REPLACE FUNCTION get_latest_price(p_token_id UUID)
RETURNS TABLE (
    price NUMERIC(30,10),
    bucket_time TIMESTAMPTZ,
    volume_sol_1h NUMERIC(20,9),
    trade_count_1h INTEGER
) AS $$
BEGIN
    RETURN QUERY
    WITH latest_candle AS (
        SELECT 
            close as price,
            bucket as bucket_time
        FROM price_candles_1m_cagg
        WHERE token_id = p_token_id
        ORDER BY bucket DESC
        LIMIT 1
    ),
    hourly_stats AS (
        SELECT 
            COALESCE(sum(volume_sol), 0) as volume_sol_1h,
            COALESCE(sum(trade_count), 0)::INTEGER as trade_count_1h
        FROM price_candles_1m_cagg
        WHERE token_id = p_token_id
            AND bucket > NOW() - INTERVAL '1 hour'
    )
    SELECT 
        lc.price,
        lc.bucket_time,
        hs.volume_sol_1h,
        hs.trade_count_1h
    FROM latest_candle lc
    CROSS JOIN hourly_stats hs;
END;
$$ LANGUAGE plpgsql;

-- Update get_price_change function to use continuous aggregate
CREATE OR REPLACE FUNCTION get_price_change(
    p_token_id UUID,
    p_interval INTERVAL DEFAULT INTERVAL '1 hour'
)
RETURNS TABLE (
    current_price NUMERIC(30,10),
    previous_price NUMERIC(30,10),
    price_change NUMERIC(30,10),
    price_change_percent NUMERIC(10,2)
) AS $$
BEGIN
    RETURN QUERY
    WITH current_price AS (
        SELECT close as price
        FROM price_candles_1m_cagg
        WHERE token_id = p_token_id
        ORDER BY bucket DESC
        LIMIT 1
    ),
    previous_price AS (
        SELECT close as price
        FROM price_candles_1m_cagg
        WHERE token_id = p_token_id
            AND bucket <= NOW() - p_interval
        ORDER BY bucket DESC
        LIMIT 1
    )
    SELECT 
        cp.price as current_price,
        pp.price as previous_price,
        cp.price - pp.price as price_change,
        CASE 
            WHEN pp.price > 0 THEN ((cp.price - pp.price) / pp.price * 100)::NUMERIC(10,2)
            ELSE 0
        END as price_change_percent
    FROM current_price cp
    CROSS JOIN previous_price pp;
END;
$$ LANGUAGE plpgsql;

-- Update high_volume_tokens view to use continuous aggregate
CREATE OR REPLACE VIEW high_volume_tokens AS
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