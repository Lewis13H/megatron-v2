-- Add missing USD columns to pools table
ALTER TABLE pools 
ADD COLUMN IF NOT EXISTS initial_price_usd NUMERIC,
ADD COLUMN IF NOT EXISTS latest_price_usd NUMERIC;

-- Add indexes for USD columns
CREATE INDEX IF NOT EXISTS idx_pools_latest_price_usd ON pools(latest_price_usd) WHERE latest_price_usd IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pools_initial_price_usd ON pools(initial_price_usd) WHERE initial_price_usd IS NOT NULL;

-- Update existing pools with USD values based on current SOL price
UPDATE pools p
SET 
    latest_price_usd = CASE 
        WHEN p.latest_price IS NOT NULL THEN 
            p.latest_price::numeric * (
                SELECT price_usd 
                FROM sol_usd_prices 
                WHERE price_time <= p.updated_at 
                ORDER BY price_time DESC 
                LIMIT 1
            )
        ELSE NULL
    END,
    initial_price_usd = CASE 
        WHEN p.initial_price IS NOT NULL THEN 
            p.initial_price::numeric * (
                SELECT price_usd 
                FROM sol_usd_prices 
                WHERE price_time <= p.created_at 
                ORDER BY price_time DESC 
                LIMIT 1
            )
        ELSE NULL
    END
WHERE p.latest_price_usd IS NULL 
   OR p.initial_price_usd IS NULL;