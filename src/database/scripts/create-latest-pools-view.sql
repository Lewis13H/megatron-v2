-- Create latest_pools view to get the most recent pool data per token
CREATE OR REPLACE VIEW latest_pools AS
SELECT DISTINCT ON (token_id)
    id,
    pool_address,
    token_id,
    base_mint,
    quote_mint,
    platform,
    initial_price,
    initial_price_usd,
    initial_base_liquidity,
    initial_quote_liquidity,
    bonding_curve_address,
    virtual_sol_reserves,
    virtual_token_reserves,
    real_sol_reserves,
    real_token_reserves,
    bonding_curve_progress,
    lp_mint,
    base_vault,
    quote_vault,
    status,
    latest_price,
    latest_price_usd,
    pool_type,
    created_at,
    updated_at
FROM pools
ORDER BY token_id, updated_at DESC NULLS LAST, created_at DESC;