-- Session 2: Pool Data & Relationships
-- Create pools table with support for both Pump.fun and Raydium Launchpad

CREATE TABLE pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_address VARCHAR(44) UNIQUE NOT NULL,
    token_id UUID REFERENCES tokens(id) NOT NULL,
    base_mint VARCHAR(44) NOT NULL,
    quote_mint VARCHAR(44) NOT NULL,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('pumpfun', 'raydium_launchpad')),
    initial_price NUMERIC(30,10),
    initial_base_liquidity NUMERIC(20,0),
    initial_quote_liquidity NUMERIC(20,0),
    
    -- Pump.fun specific fields
    bonding_curve_address VARCHAR(44),
    virtual_sol_reserves NUMERIC(20,0),
    virtual_token_reserves NUMERIC(20,0),
    real_sol_reserves NUMERIC(20,0),
    real_token_reserves NUMERIC(20,0),
    bonding_curve_progress NUMERIC(5,2),
    
    -- Raydium specific fields
    lp_mint VARCHAR(44),
    base_vault VARCHAR(44),
    quote_vault VARCHAR(44),
    
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'graduated', 'closed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX idx_pools_token_id ON pools(token_id);
CREATE INDEX idx_pools_platform ON pools(platform);
CREATE INDEX idx_pools_pool_address ON pools(pool_address);
CREATE INDEX idx_pools_status ON pools(status);
CREATE INDEX idx_pools_created_at ON pools(created_at DESC);

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_pools_updated_at BEFORE UPDATE ON pools
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add foreign key constraint to ensure data integrity
ALTER TABLE pools ADD CONSTRAINT fk_pools_token 
    FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE;