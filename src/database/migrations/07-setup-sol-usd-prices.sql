-- Setup for SOL/USD price tracking
-- Creates tables and infrastructure for tracking Solana price in USD

-- Historical SOL/USD prices for backtesting and historical calculations
CREATE TABLE IF NOT EXISTS sol_usd_prices (
    id UUID DEFAULT gen_random_uuid(),
    price_time TIMESTAMPTZ NOT NULL,
    price_usd NUMERIC(20,6) NOT NULL,
    source VARCHAR(50) NOT NULL, -- 'pyth', 'jupiter', 'birdeye', etc.
    confidence NUMERIC(20,6), -- Pyth confidence interval
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (price_time, source, id),
    UNIQUE(price_time, source)
);

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('sol_usd_prices', 'price_time', if_not_exists => TRUE);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_sol_usd_prices_time ON sol_usd_prices(price_time DESC);
CREATE INDEX IF NOT EXISTS idx_sol_usd_prices_source ON sol_usd_prices(source);

-- Continuous aggregate for SOL/USD candles
-- Note: This needs to be created separately due to transaction limitations
-- CREATE MATERIALIZED VIEW IF NOT EXISTS sol_usd_candles_1m
-- WITH (timescaledb.continuous) AS
-- SELECT
--     time_bucket('1 minute', price_time) AS bucket,
--     first(price_usd, price_time) AS open,
--     max(price_usd) AS high,
--     min(price_usd) AS low,
--     last(price_usd, price_time) AS close,
--     avg(price_usd) AS average,
--     count(*) AS sample_count,
--     source
-- FROM sol_usd_prices
-- GROUP BY time_bucket('1 minute', price_time), source;

-- Add continuous aggregate policy
-- SELECT add_continuous_aggregate_policy('sol_usd_candles_1m',
--     start_offset => INTERVAL '3 hours',
--     end_offset => INTERVAL '10 minutes',
--     schedule_interval => INTERVAL '1 minute',
--     if_not_exists => TRUE);

-- Function to get SOL/USD price at specific time
CREATE OR REPLACE FUNCTION get_sol_usd_price(p_timestamp TIMESTAMPTZ, p_source VARCHAR DEFAULT NULL)
RETURNS NUMERIC AS $$
DECLARE
    v_price NUMERIC;
BEGIN
    -- Try exact match first
    SELECT price_usd INTO v_price
    FROM sol_usd_prices
    WHERE price_time <= p_timestamp
        AND (p_source IS NULL OR source = p_source)
    ORDER BY price_time DESC
    LIMIT 1;
    
    -- If no price found, use interpolation
    IF v_price IS NULL THEN
        WITH prices AS (
            SELECT 
                price_usd,
                price_time,
                LEAD(price_usd) OVER (ORDER BY price_time) as next_price,
                LEAD(price_time) OVER (ORDER BY price_time) as next_time
            FROM sol_usd_prices
            WHERE price_time <= p_timestamp + INTERVAL '1 hour'
                AND price_time >= p_timestamp - INTERVAL '1 hour'
                AND (p_source IS NULL OR source = p_source)
        )
        SELECT 
            price_usd + (next_price - price_usd) * 
            EXTRACT(EPOCH FROM (p_timestamp - price_time)) / 
            EXTRACT(EPOCH FROM (next_time - price_time))
        INTO v_price
        FROM prices
        WHERE price_time <= p_timestamp 
            AND next_time > p_timestamp
        LIMIT 1;
    END IF;
    
    RETURN COALESCE(v_price, 0);
END;
$$ LANGUAGE plpgsql;

-- Function to get latest SOL/USD price
CREATE OR REPLACE FUNCTION get_latest_sol_usd_price(p_source VARCHAR DEFAULT NULL)
RETURNS TABLE(price_usd NUMERIC, price_time TIMESTAMPTZ, source VARCHAR) AS $$
BEGIN
    RETURN QUERY
    SELECT s.price_usd, s.price_time, s.source
    FROM sol_usd_prices s
    WHERE p_source IS NULL OR s.source = p_source
    ORDER BY s.price_time DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Add USD columns to price_candles_1m
ALTER TABLE price_candles_1m 
ADD COLUMN IF NOT EXISTS open_usd NUMERIC(30,6),
ADD COLUMN IF NOT EXISTS high_usd NUMERIC(30,6),
ADD COLUMN IF NOT EXISTS low_usd NUMERIC(30,6),
ADD COLUMN IF NOT EXISTS close_usd NUMERIC(30,6),
ADD COLUMN IF NOT EXISTS volume_usd NUMERIC(20,2);

-- Add USD price to transactions
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS price_per_token_usd NUMERIC(30,6),
ADD COLUMN IF NOT EXISTS sol_amount_usd NUMERIC(20,2);

-- Function to update USD values for a transaction
CREATE OR REPLACE FUNCTION calculate_transaction_usd_values()
RETURNS TRIGGER AS $$
DECLARE
    v_sol_price NUMERIC;
BEGIN
    -- Get SOL price at transaction time (preferring Pyth)
    v_sol_price := get_sol_usd_price(NEW.block_time, 'pyth');
    
    -- If no Pyth price, try any source
    IF v_sol_price = 0 OR v_sol_price IS NULL THEN
        v_sol_price := get_sol_usd_price(NEW.block_time);
    END IF;
    
    -- Calculate USD values only if we have a price
    IF v_sol_price > 0 THEN
        NEW.price_per_token_usd := NEW.price_per_token * v_sol_price;
        NEW.sol_amount_usd := (NEW.sol_amount / 1e9) * v_sol_price;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for new transactions
DROP TRIGGER IF EXISTS trg_calculate_usd_values ON transactions;
CREATE TRIGGER trg_calculate_usd_values
BEFORE INSERT ON transactions
FOR EACH ROW
EXECUTE FUNCTION calculate_transaction_usd_values();

-- Function to backfill USD values for existing transactions
CREATE OR REPLACE FUNCTION backfill_transaction_usd_values(
    p_start_time TIMESTAMPTZ DEFAULT NULL,
    p_end_time TIMESTAMPTZ DEFAULT NULL,
    p_batch_size INT DEFAULT 1000
)
RETURNS TABLE(updated_count INT) AS $$
DECLARE
    v_updated INT := 0;
    v_total_updated INT := 0;
BEGIN
    LOOP
        WITH batch AS (
            SELECT t.id, t.block_time, t.price_per_token, t.sol_amount
            FROM transactions t
            WHERE (t.price_per_token_usd IS NULL OR t.sol_amount_usd IS NULL)
                AND (p_start_time IS NULL OR t.block_time >= p_start_time)
                AND (p_end_time IS NULL OR t.block_time <= p_end_time)
            LIMIT p_batch_size
            FOR UPDATE SKIP LOCKED
        )
        UPDATE transactions t
        SET 
            price_per_token_usd = t.price_per_token * get_sol_usd_price(b.block_time),
            sol_amount_usd = (t.sol_amount / 1e9) * get_sol_usd_price(b.block_time)
        FROM batch b
        WHERE t.id = b.id
            AND get_sol_usd_price(b.block_time) > 0;
        
        GET DIAGNOSTICS v_updated = ROW_COUNT;
        v_total_updated := v_total_updated + v_updated;
        
        EXIT WHEN v_updated = 0;
        
        -- Sleep briefly to avoid overwhelming the database
        PERFORM pg_sleep(0.1);
    END LOOP;
    
    RETURN QUERY SELECT v_total_updated;
END;
$$ LANGUAGE plpgsql;

-- View for monitoring SOL/USD price health
CREATE OR REPLACE VIEW sol_usd_price_health AS
SELECT
    source,
    COUNT(*) as total_records,
    MIN(price_time) as oldest_price,
    MAX(price_time) as latest_price,
    AGE(NOW(), MAX(price_time)) as last_update_age,
    AVG(price_usd) as avg_price_24h,
    MIN(price_usd) as min_price_24h,
    MAX(price_usd) as max_price_24h,
    STDDEV(price_usd) as price_stddev_24h
FROM sol_usd_prices
WHERE price_time > NOW() - INTERVAL '24 hours'
GROUP BY source;

-- Grant permissions
GRANT SELECT, INSERT ON sol_usd_prices TO PUBLIC;
GRANT SELECT ON sol_usd_price_health TO PUBLIC;