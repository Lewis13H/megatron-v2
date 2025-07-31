-- Migration: 006_add_latest_price_to_pools
-- Description: Adds latest_price column to pools table for quick price lookups
-- Dependencies: 002_create_pools_table
ALTER TABLE pools ADD COLUMN IF NOT EXISTS latest_price NUMERIC(30,20);

-- Create index for price queries
CREATE INDEX IF NOT EXISTS idx_pools_latest_price ON pools(latest_price);

-- Add comment to explain the column
COMMENT ON COLUMN pools.latest_price IS 'Latest price in SOL per token from Pump.fun price monitor';