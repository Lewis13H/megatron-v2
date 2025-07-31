-- Migration: 014_add_usd_prices_to_pools
-- Description: Adds USD price columns to pools table
-- Dependencies: 002_create_pools_table, 006_add_latest_price_to_pools

-- Add initial_price_usd column
ALTER TABLE pools ADD COLUMN IF NOT EXISTS initial_price_usd NUMERIC(30,10);

-- Add latest_price_usd column
ALTER TABLE pools ADD COLUMN IF NOT EXISTS latest_price_usd NUMERIC(30,10);

-- Create indexes for USD price queries
CREATE INDEX IF NOT EXISTS idx_pools_initial_price_usd ON pools(initial_price_usd);
CREATE INDEX IF NOT EXISTS idx_pools_latest_price_usd ON pools(latest_price_usd);

-- Add comments to explain the columns
COMMENT ON COLUMN pools.initial_price_usd IS 'Initial price in USD per token at pool creation';
COMMENT ON COLUMN pools.latest_price_usd IS 'Latest price in USD per token';