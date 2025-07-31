-- Migration: 004_create_price_aggregates
-- Description: Creates price candles table and related functions for price analytics
-- Dependencies: 003_create_transactions_hypertable
-- Note: Continuous aggregate must be created separately outside transaction

-- Create 1-minute price candles table
CREATE TABLE IF NOT EXISTS price_candles_1m (
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

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('price_candles_1m', 'bucket', if_not_exists => TRUE);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_price_candles_1m_token ON price_candles_1m(token_id);
CREATE INDEX IF NOT EXISTS idx_price_candles_1m_bucket ON price_candles_1m(bucket DESC);
CREATE INDEX IF NOT EXISTS idx_price_candles_1m_token_bucket ON price_candles_1m(token_id, bucket DESC);

-- Add table comment
COMMENT ON TABLE price_candles_1m IS '1-minute price candles for token price tracking';
COMMENT ON COLUMN price_candles_1m.bucket IS 'Start time of the 1-minute candle';
COMMENT ON COLUMN price_candles_1m.open IS 'Opening price in SOL per token';
COMMENT ON COLUMN price_candles_1m.close IS 'Closing price in SOL per token';

-- Create helper function to get latest price for a token
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
        FROM price_candles_1m
        WHERE token_id = p_token_id
        ORDER BY bucket DESC
        LIMIT 1
    ),
    hourly_stats AS (
        SELECT 
            COALESCE(sum(volume_sol), 0) as volume_sol_1h,
            COALESCE(sum(trade_count), 0)::INTEGER as trade_count_1h
        FROM price_candles_1m
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

-- Create function to get price change over time
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
        FROM price_candles_1m
        WHERE token_id = p_token_id
        ORDER BY bucket DESC
        LIMIT 1
    ),
    previous_price AS (
        SELECT close as price
        FROM price_candles_1m
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

-- Create view for recent high-volume tokens
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
FROM price_candles_1m pc
JOIN tokens t ON pc.token_id = t.id
WHERE pc.bucket > NOW() - INTERVAL '1 hour'
GROUP BY t.mint_address, t.symbol, t.name, pc.token_id
HAVING sum(pc.volume_sol) > 10  -- More than 10 SOL volume
ORDER BY volume_sol_1h DESC;

-- Add compression policy for price candles (compress after 7 days)
DO $$
BEGIN
    -- Check if compression is already enabled
    IF NOT EXISTS (
        SELECT 1 
        FROM timescaledb_information.compression_settings 
        WHERE hypertable_name = 'price_candles_1m'
    ) THEN
        -- Enable compression on the hypertable
        PERFORM alter_table_compression('price_candles_1m', compress => true);
        
        -- Add compression policy
        PERFORM add_compression_policy('price_candles_1m', INTERVAL '7 days');
        RAISE NOTICE 'Compression enabled and policy added for price_candles_1m';
    ELSE
        RAISE NOTICE 'Compression already enabled for price_candles_1m';
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Compression not available or already configured: %', SQLERRM;
END
$$;

-- Note: Run the following SQL separately to create continuous aggregate:
-- CREATE MATERIALIZED VIEW IF NOT EXISTS price_candles_1m_cagg
-- WITH (timescaledb.continuous) AS
-- SELECT
--     token_id,
--     time_bucket('1 minute', block_time) AS bucket,
--     first(price_per_token, block_time) AS open,
--     max(price_per_token) AS high,
--     min(price_per_token) AS low,
--     last(price_per_token, block_time) AS close,
--     sum(CASE WHEN type IN ('buy', 'sell') THEN token_amount ELSE 0 END) AS volume_token,
--     sum(CASE WHEN type IN ('buy', 'sell') THEN sol_amount ELSE 0 END) AS volume_sol,
--     count(*) AS trade_count,
--     count(DISTINCT CASE WHEN type = 'buy' THEN user_address END) AS buyer_count,
--     count(DISTINCT CASE WHEN type = 'sell' THEN user_address END) AS seller_count
-- FROM transactions
-- WHERE price_per_token IS NOT NULL AND price_per_token > 0
-- GROUP BY token_id, time_bucket('1 minute', block_time);