-- Add support for graduated token platforms (Raydium AMM and PumpSwap)

-- Drop the existing constraint
ALTER TABLE pools 
DROP CONSTRAINT pools_platform_check;

-- Add the new constraint with additional platforms
ALTER TABLE pools 
ADD CONSTRAINT pools_platform_check 
CHECK (platform IN ('pumpfun', 'raydium_launchpad', 'raydium', 'pumpswap', 'raydium_cpmm'));

-- Add a pool_type column to distinguish between initial pools and graduated pools
ALTER TABLE pools 
ADD COLUMN IF NOT EXISTS pool_type VARCHAR(20) DEFAULT 'initial' 
CHECK (pool_type IN ('initial', 'graduated'));

-- Update existing pools to have the correct pool_type
UPDATE pools 
SET pool_type = 'initial' 
WHERE pool_type IS NULL;

-- Add index for pool_type
CREATE INDEX IF NOT EXISTS idx_pools_pool_type ON pools(pool_type);

-- Add comments
COMMENT ON COLUMN pools.platform IS 'Platform hosting the pool: pumpfun, raydium_launchpad, raydium (AMM V4), pumpswap, raydium_cpmm';
COMMENT ON COLUMN pools.pool_type IS 'Type of pool: initial (bonding curve) or graduated (full DEX)';