-- Add latest_price column to pools table to store the formatted price in SOL
ALTER TABLE pools ADD COLUMN IF NOT EXISTS latest_price NUMERIC(30,20);

-- Create index for price queries
CREATE INDEX IF NOT EXISTS idx_pools_latest_price ON pools(latest_price);

-- Add comment to explain the column
COMMENT ON COLUMN pools.latest_price IS 'Latest price in SOL per token from Pump.fun price monitor';