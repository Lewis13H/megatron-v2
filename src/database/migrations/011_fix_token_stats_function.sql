-- Migration: 011_fix_token_stats_function
-- Description: Fixes ambiguous column reference in token stats function
-- Dependencies: 010_add_usd_price_enhancements

DROP FUNCTION IF EXISTS get_token_stats_with_usd(UUID);

CREATE OR REPLACE FUNCTION get_token_stats_with_usd(p_token_id UUID)
RETURNS TABLE (
    out_token_id UUID,
    out_latest_price_sol NUMERIC,
    out_latest_price_usd NUMERIC,
    out_volume_24h_sol NUMERIC,
    out_volume_24h_usd NUMERIC,
    out_high_24h_sol NUMERIC,
    out_high_24h_usd NUMERIC,
    out_low_24h_sol NUMERIC,
    out_low_24h_usd NUMERIC,
    out_price_change_24h_pct NUMERIC,
    out_last_updated TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    WITH latest_data AS (
        SELECT 
            pc.token_id,
            pc.close as latest_price_sol,
            pc.close * get_sol_usd_price(pc.bucket + INTERVAL '1 minute') as latest_price_usd,
            pc.bucket as last_updated
        FROM price_candles_1m pc
        WHERE pc.token_id = p_token_id
        ORDER BY pc.bucket DESC
        LIMIT 1
    ),
    stats_24h AS (
        SELECT
            pc.token_id,
            SUM(pc.volume_sol) as volume_24h_sol,
            SUM(pc.volume_sol * get_sol_usd_price(pc.bucket)) as volume_24h_usd,
            MAX(pc.high) as high_24h_sol,
            MAX(pc.high * get_sol_usd_price(pc.bucket)) as high_24h_usd,
            MIN(pc.low) as low_24h_sol,
            MIN(pc.low * get_sol_usd_price(pc.bucket)) as low_24h_usd
        FROM price_candles_1m pc
        WHERE pc.token_id = p_token_id
            AND pc.bucket > NOW() - INTERVAL '24 hours'
        GROUP BY pc.token_id
    ),
    price_24h_ago AS (
        SELECT close as price_24h_ago
        FROM price_candles_1m
        WHERE price_candles_1m.token_id = p_token_id
            AND bucket <= NOW() - INTERVAL '24 hours'
        ORDER BY bucket DESC
        LIMIT 1
    )
    SELECT 
        ld.token_id::UUID,
        ld.latest_price_sol::NUMERIC,
        ld.latest_price_usd::NUMERIC,
        COALESCE(s.volume_24h_sol, 0)::NUMERIC,
        COALESCE(s.volume_24h_usd, 0)::NUMERIC,
        COALESCE(s.high_24h_sol, ld.latest_price_sol)::NUMERIC,
        COALESCE(s.high_24h_usd, ld.latest_price_usd)::NUMERIC,
        COALESCE(s.low_24h_sol, ld.latest_price_sol)::NUMERIC,
        COALESCE(s.low_24h_usd, ld.latest_price_usd)::NUMERIC,
        CASE 
            WHEN p24.price_24h_ago > 0 THEN 
                ((ld.latest_price_sol - p24.price_24h_ago) / p24.price_24h_ago) * 100
            ELSE 0
        END::NUMERIC as price_change_24h_pct,
        ld.last_updated::TIMESTAMPTZ
    FROM latest_data ld
    LEFT JOIN stats_24h s ON ld.token_id = s.token_id
    CROSS JOIN price_24h_ago p24;
END;
$$ LANGUAGE plpgsql;