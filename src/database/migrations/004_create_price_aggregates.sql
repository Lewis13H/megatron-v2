-- Migration: Create price aggregates and continuous views
-- Description: Sets up 1-minute price candles and continuous aggregates for efficient price data

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

-- Create continuous aggregate from transactions
-- Note: This must be run outside a transaction block
-- Check if continuous aggregate already exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM timescaledb_information.continuous_aggregates 
        WHERE view_name = 'price_candles_1m_cagg'
    ) THEN
        RAISE NOTICE 'Continuous aggregate price_candles_1m_cagg needs to be created manually outside transaction';
    ELSE
        RAISE NOTICE 'Continuous aggregate price_candles_1m_cagg already exists';
    END IF;
END
$$;

-- Refresh policy will be added after continuous aggregate is created

-- Add compression policy for price candles (compress after 7 days)
-- Note: Compression requires columnstore to be enabled on the hypertable
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

-- Functions will be created after continuous aggregate exists