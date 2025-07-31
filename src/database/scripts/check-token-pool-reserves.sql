-- Simple query to check tokens with their pool reserve data
WITH token_pool_stats AS (
  SELECT 
    t.id as token_id,
    t.mint_address,
    t.symbol,
    t.name,
    t.platform as token_platform,
    t.creation_timestamp,
    t.is_graduated,
    p.id as pool_id,
    p.pool_address,
    p.platform as pool_platform,
    p.status as pool_status,
    p.real_sol_reserves,
    p.real_token_reserves,
    p.virtual_sol_reserves,
    p.virtual_token_reserves,
    p.created_at as pool_created_at,
    p.updated_at as pool_updated_at,
    -- Calculate if pool has been updated by account monitor
    CASE 
      WHEN p.updated_at > p.created_at THEN TRUE 
      ELSE FALSE 
    END as pool_has_updates,
    -- Calculate current price from real reserves (Raydium Launchpad uses real reserves for pricing)
    CASE 
      WHEN p.real_token_reserves > 0 AND p.real_token_reserves IS NOT NULL 
      THEN (p.real_sol_reserves::numeric / 1e9) / (p.real_token_reserves::numeric / 1e6) 
      ELSE NULL 
    END as current_price_from_reserves
  FROM tokens t
  LEFT JOIN pools p ON t.id = p.token_id
  WHERE t.platform = 'raydium_launchpad' OR p.platform = 'raydium_launchpad'
)
SELECT 
  mint_address,
  symbol,
  name,
  pool_address,
  pool_status,
  real_sol_reserves,
  real_token_reserves,
  virtual_sol_reserves,
  virtual_token_reserves,
  pool_has_updates,
  current_price_from_reserves,
  pool_created_at,
  pool_updated_at
FROM token_pool_stats
ORDER BY pool_updated_at DESC NULLS LAST;