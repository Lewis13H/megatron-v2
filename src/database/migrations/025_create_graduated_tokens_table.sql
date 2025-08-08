-- Create graduated_tokens table for tracking token graduations
CREATE TABLE IF NOT EXISTS graduated_tokens (
  id SERIAL PRIMARY KEY,
  token_mint VARCHAR(44) UNIQUE NOT NULL,
  graduation_timestamp TIMESTAMP,
  graduation_signature VARCHAR(88),
  migration_type VARCHAR(20) DEFAULT 'raydium',
  raydium_pool_address VARCHAR(44),
  graduation_price DECIMAL(20, 9),
  graduation_market_cap DECIMAL(20, 2),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_graduated_tokens_mint ON graduated_tokens(token_mint);
CREATE INDEX IF NOT EXISTS idx_graduated_tokens_timestamp ON graduated_tokens(graduation_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_graduated_tokens_migration ON graduated_tokens(migration_type);

-- Add update trigger
CREATE TRIGGER update_graduated_tokens_updated_at
  BEFORE UPDATE ON graduated_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Insert the graduated token
INSERT INTO graduated_tokens (
  token_mint,
  graduation_timestamp,
  migration_type,
  graduation_price,
  created_at
) VALUES (
  'HcN4rDycUdKVkk5L5d8FXvSDA3TuM4LL7GuGXUjmpump',
  NOW() - INTERVAL '1 hour', -- Assume it graduated 1 hour ago
  'raydium',
  0.0001, -- Placeholder price
  NOW()
) ON CONFLICT (token_mint) DO NOTHING;

-- Also update the pool status if it exists
UPDATE pools 
SET 
  status = 'graduated',
  pool_type = 'graduated',
  bonding_curve_progress = 100.00
WHERE 
  base_mint = 'HcN4rDycUdKVkk5L5d8FXvSDA3TuM4LL7GuGXUjmpump'
  OR quote_mint = 'HcN4rDycUdKVkk5L5d8FXvSDA3TuM4LL7GuGXUjmpump';