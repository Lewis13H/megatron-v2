-- Migration: 003_create_transactions_hypertable
-- Description: Creates transactions hypertable for time-series transaction data
-- Dependencies: 001_create_tokens_table, 002_create_pools_table

-- Create transactions table
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
    
    -- Fees
    protocol_fee NUMERIC(20,0),
    platform_fee NUMERIC(20,0),
    transaction_fee BIGINT,
    
    success BOOLEAN DEFAULT TRUE,
    raw_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Convert to TimescaleDB hypertable for efficient time-series storage
SELECT create_hypertable('transactions', 'block_time');

-- Add composite primary key including the partitioning column
ALTER TABLE transactions ADD PRIMARY KEY (signature, block_time);

-- Create non-unique index on signature for fast lookups
-- (signature is unique in practice but we can't enforce it without block_time)
CREATE INDEX idx_transactions_signature ON transactions(signature);

-- Create indexes for common query patterns
CREATE INDEX idx_transactions_token_id_time ON transactions(token_id, block_time DESC);
CREATE INDEX idx_transactions_pool_id_time ON transactions(pool_id, block_time DESC);
CREATE INDEX idx_transactions_user_time ON transactions(user_address, block_time DESC);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_success ON transactions(success) WHERE success = false;

-- Create composite index for price analysis
CREATE INDEX idx_transactions_token_type_time ON transactions(token_id, type, block_time DESC);

-- Create a function to calculate normalized amounts
CREATE OR REPLACE FUNCTION calculate_normalized_amounts()
RETURNS TRIGGER AS $$
BEGIN
    -- Calculate normalized amounts if not already set
    IF NEW.sol_amount IS NULL OR NEW.token_amount IS NULL THEN
        -- Determine which is SOL and which is token based on type
        IF NEW.type IN ('buy', 'add_liquidity') THEN
            -- For buys: amount_in is SOL, amount_out is token
            NEW.sol_amount = NEW.amount_in / POWER(10, NEW.amount_in_decimals);
            NEW.token_amount = NEW.amount_out / POWER(10, NEW.amount_out_decimals);
        ELSE
            -- For sells: amount_in is token, amount_out is SOL
            NEW.token_amount = NEW.amount_in / POWER(10, NEW.amount_in_decimals);
            NEW.sol_amount = NEW.amount_out / POWER(10, NEW.amount_out_decimals);
        END IF;
    END IF;
    
    -- Calculate price per token if not set
    IF NEW.price_per_token IS NULL AND NEW.sol_amount > 0 AND NEW.token_amount > 0 THEN
        NEW.price_per_token = NEW.sol_amount / NEW.token_amount;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to calculate normalized amounts
CREATE TRIGGER trg_calculate_normalized_amounts
    BEFORE INSERT OR UPDATE ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION calculate_normalized_amounts();

-- Create a view for recent transaction activity
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

-- Create a function to get transaction volume statistics
CREATE OR REPLACE FUNCTION get_transaction_volume_stats(
    p_token_id UUID,
    p_interval INTERVAL DEFAULT INTERVAL '24 hours'
)
RETURNS TABLE (
    total_volume_sol NUMERIC,
    total_volume_token NUMERIC,
    buy_volume_sol NUMERIC,
    sell_volume_sol NUMERIC,
    transaction_count BIGINT,
    unique_traders BIGINT,
    avg_transaction_size_sol NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        SUM(sol_amount) as total_volume_sol,
        SUM(token_amount) as total_volume_token,
        SUM(CASE WHEN type = 'buy' THEN sol_amount ELSE 0 END) as buy_volume_sol,
        SUM(CASE WHEN type = 'sell' THEN sol_amount ELSE 0 END) as sell_volume_sol,
        COUNT(*) as transaction_count,
        COUNT(DISTINCT user_address) as unique_traders,
        AVG(sol_amount) as avg_transaction_size_sol
    FROM transactions
    WHERE token_id = p_token_id
        AND block_time > NOW() - p_interval
        AND type IN ('buy', 'sell');
END;
$$ LANGUAGE plpgsql;

-- Add compression policy for older data (after 7 days)
-- First check if compression is available and set it up properly
DO $$
BEGIN
    -- Try to add compression policy
    -- Some TimescaleDB versions require enabling compression first
    BEGIN
        ALTER TABLE transactions SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'token_id',
            timescaledb.compress_orderby = 'block_time DESC'
        );
        PERFORM add_compression_policy('transactions', INTERVAL '7 days');
        RAISE NOTICE 'Compression policy added successfully';
    EXCEPTION
        WHEN OTHERS THEN
            RAISE NOTICE 'Compression policy could not be added: %', SQLERRM;
    END;
END $$;

-- Add retention policy for very old data (after 90 days)
DO $$
BEGIN
    BEGIN
        PERFORM add_retention_policy('transactions', INTERVAL '90 days');
        RAISE NOTICE 'Retention policy added successfully';
    EXCEPTION
        WHEN OTHERS THEN
            RAISE NOTICE 'Retention policy could not be added: %', SQLERRM;
    END;
END $$;

-- Add table comments
COMMENT ON TABLE transactions IS 'Time-series data for all token transactions (buys, sells, liquidity changes)';
COMMENT ON COLUMN transactions.type IS 'Transaction type: buy, sell, add_liquidity, or remove_liquidity';
COMMENT ON COLUMN transactions.price_per_token IS 'Calculated price in SOL per token at transaction time';