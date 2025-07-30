-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Drop table if exists (for clean setup)
DROP TABLE IF EXISTS tokens CASCADE;

-- Create tokens table
CREATE TABLE tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mint_address VARCHAR(44) UNIQUE NOT NULL,
    symbol VARCHAR(10),
    name VARCHAR(100),
    decimals INTEGER NOT NULL DEFAULT 6,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('pumpfun', 'raydium_launchpad')),
    creation_signature VARCHAR(88) NOT NULL,
    creation_timestamp TIMESTAMPTZ NOT NULL,
    creator_address VARCHAR(44) NOT NULL,
    initial_supply NUMERIC(20,0),
    metadata JSONB,
    is_graduated BOOLEAN DEFAULT FALSE,
    graduation_timestamp TIMESTAMPTZ,
    graduation_signature VARCHAR(88),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX idx_tokens_mint_address ON tokens(mint_address);
CREATE INDEX idx_tokens_platform ON tokens(platform);
CREATE INDEX idx_tokens_creation_timestamp ON tokens(creation_timestamp);
CREATE INDEX idx_tokens_creator ON tokens(creator_address);
CREATE INDEX idx_tokens_graduated ON tokens(is_graduated);

-- Create update trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_tokens_updated_at BEFORE UPDATE
    ON tokens FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Verify table creation
SELECT 
    column_name,
    data_type,
    character_maximum_length,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'tokens'
ORDER BY ordinal_position;