-- Migration: 012_fix_materialized_view_refresh
-- Description: Fixes materialized view refresh functions
-- Dependencies: 010_add_usd_price_enhancements

-- Update the refresh function to use non-concurrent refresh
CREATE OR REPLACE FUNCTION refresh_top_tokens_usd()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW top_tokens_by_usd_volume;
END;
$$ LANGUAGE plpgsql;

-- Also create a unique index on token_id for future concurrent refreshes
CREATE UNIQUE INDEX IF NOT EXISTS idx_top_tokens_token_id ON top_tokens_by_usd_volume(token_id);

-- Now we can use concurrent refresh
CREATE OR REPLACE FUNCTION refresh_top_tokens_usd_concurrent()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY top_tokens_by_usd_volume;
END;
$$ LANGUAGE plpgsql;

-- Refresh the view with initial data
SELECT refresh_top_tokens_usd();