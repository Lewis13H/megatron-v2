-- Comprehensive query to analyze tokens with pool data and transaction activity
-- This query combines data from tokens, pools, and transactions tables

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
),
transaction_stats AS (
  SELECT 
    token_id,
    COUNT(*) as total_transactions,
    COUNT(CASE WHEN type = 'buy' THEN 1 END) as buy_count,
    COUNT(CASE WHEN type = 'sell' THEN 1 END) as sell_count,
    SUM(CASE WHEN type = 'buy' THEN sol_amount ELSE 0 END) as total_buy_volume_sol,
    SUM(CASE WHEN type = 'sell' THEN sol_amount ELSE 0 END) as total_sell_volume_sol,
    COUNT(DISTINCT user_address) as unique_traders,
    MIN(block_time) as first_trade_time,
    MAX(block_time) as last_trade_time,
    AVG(price_per_token) as avg_price,
    MAX(price_per_token) as max_price,
    MIN(price_per_token) as min_price
  FROM transactions
  WHERE token_id IN (SELECT token_id FROM token_pool_stats)
  GROUP BY token_id
),
recent_trades AS (
  SELECT DISTINCT ON (token_id)
    token_id,
    price_per_token as latest_price,
    sol_amount as latest_trade_sol,
    token_amount as latest_trade_tokens,
    type as latest_trade_type,
    block_time as latest_trade_time
  FROM transactions
  WHERE token_id IN (SELECT token_id FROM token_pool_stats)
  ORDER BY token_id, block_time DESC
)
SELECT 
  -- Token Info
  tps.mint_address,
  COALESCE(tps.symbol, 'Unknown') as symbol,
  COALESCE(tps.name, 'Unnamed') as name,
  tps.token_platform,
  tps.creation_timestamp,
  tps.is_graduated,
  
  -- Pool Info
  tps.pool_address,
  tps.pool_status,
  tps.pool_created_at,
  tps.pool_updated_at,
  tps.pool_has_updates,
  
  -- Reserve Data (from account monitor)
  tps.real_sol_reserves,
  tps.real_token_reserves,
  tps.virtual_sol_reserves,
  tps.virtual_token_reserves,
  ROUND(tps.current_price_from_reserves::numeric, 10) as price_from_reserves,
  
  -- Transaction Data (from transaction monitor)
  COALESCE(ts.total_transactions, 0) as total_transactions,
  COALESCE(ts.buy_count, 0) as buy_count,
  COALESCE(ts.sell_count, 0) as sell_count,
  ROUND(COALESCE(ts.total_buy_volume_sol, 0)::numeric, 4) as total_buy_volume_sol,
  ROUND(COALESCE(ts.total_sell_volume_sol, 0)::numeric, 4) as total_sell_volume_sol,
  ROUND((COALESCE(ts.total_buy_volume_sol, 0) + COALESCE(ts.total_sell_volume_sol, 0))::numeric, 4) as total_volume_sol,
  COALESCE(ts.unique_traders, 0) as unique_traders,
  
  -- Price Data
  ROUND(COALESCE(ts.avg_price, 0)::numeric, 10) as avg_trade_price,
  ROUND(COALESCE(ts.max_price, 0)::numeric, 10) as max_trade_price,
  ROUND(COALESCE(ts.min_price, 0)::numeric, 10) as min_trade_price,
  ROUND(COALESCE(rt.latest_price, 0)::numeric, 10) as latest_trade_price,
  
  -- Trading Activity
  ts.first_trade_time,
  ts.last_trade_time,
  rt.latest_trade_type,
  rt.latest_trade_time,
  
  -- Activity Indicators
  CASE 
    WHEN ts.last_trade_time > NOW() - INTERVAL '1 hour' THEN 'Active'
    WHEN ts.last_trade_time > NOW() - INTERVAL '24 hours' THEN 'Recent'
    WHEN ts.last_trade_time IS NOT NULL THEN 'Inactive'
    ELSE 'No trades'
  END as trading_status,
  
  -- Data Completeness
  CASE
    WHEN tps.pool_address IS NULL THEN 'No pool'
    WHEN tps.real_sol_reserves IS NULL THEN 'Pool not updated'
    WHEN ts.total_transactions IS NULL OR ts.total_transactions = 0 THEN 'No transactions'
    ELSE 'Complete data'
  END as data_status

FROM token_pool_stats tps
LEFT JOIN transaction_stats ts ON tps.token_id = ts.token_id
LEFT JOIN recent_trades rt ON tps.token_id = rt.token_id
ORDER BY 
  (COALESCE(ts.total_buy_volume_sol, 0) + COALESCE(ts.total_sell_volume_sol, 0)) DESC,
  tps.creation_timestamp DESC;

-- Summary statistics
WITH summary AS (
  SELECT 
    COUNT(DISTINCT t.id) as total_tokens,
    COUNT(DISTINCT p.id) as total_pools,
    COUNT(DISTINCT CASE WHEN p.real_sol_reserves IS NOT NULL THEN p.id END) as pools_with_reserves,
    COUNT(DISTINCT tx.token_id) as tokens_with_transactions,
    SUM(tx.sol_amount) as total_volume_sol
  FROM tokens t
  LEFT JOIN pools p ON t.id = p.token_id
  LEFT JOIN transactions tx ON t.id = tx.token_id
  WHERE t.platform = 'raydium_launchpad' OR p.platform = 'raydium_launchpad'
)
SELECT 
  'SUMMARY STATISTICS' as metric,
  total_tokens || ' tokens' as value
FROM summary
UNION ALL
SELECT 
  'Pools created',
  total_pools || ' pools'
FROM summary
UNION ALL
SELECT 
  'Pools with reserve data',
  pools_with_reserves || ' pools (' || 
  ROUND(100.0 * pools_with_reserves / NULLIF(total_pools, 0), 1) || '%)'
FROM summary
UNION ALL
SELECT 
  'Tokens with transactions',
  tokens_with_transactions || ' tokens'
FROM summary
UNION ALL
SELECT 
  'Total volume',
  ROUND(total_volume_sol::numeric, 2) || ' SOL'
FROM summary;