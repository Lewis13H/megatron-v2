-- Phase 2: USD Price Enhancements
-- Adds functions and triggers for automatic USD calculations on price candles

-- Function to update price candles with USD values
CREATE OR REPLACE FUNCTION update_price_candle_usd_values(
    p_token_id UUID,
    p_start_time TIMESTAMPTZ,
    p_end_time TIMESTAMPTZ
)
RETURNS INT AS $$
DECLARE
    v_updated INT := 0;
BEGIN
    UPDATE price_candles_1m pc
    SET 
        open_usd = pc.open * get_sol_usd_price(pc.bucket),
        high_usd = pc.high * get_sol_usd_price(pc.bucket),
        low_usd = pc.low * get_sol_usd_price(pc.bucket),
        close_usd = pc.close * get_sol_usd_price(pc.bucket + INTERVAL '1 minute'),
        volume_usd = pc.volume_sol * get_sol_usd_price(pc.bucket)
    WHERE pc.token_id = p_token_id
        AND pc.bucket >= p_start_time
        AND pc.bucket < p_end_time
        AND (pc.open_usd IS NULL OR pc.high_usd IS NULL OR pc.low_usd IS NULL OR pc.close_usd IS NULL OR pc.volume_usd IS NULL);
    
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated;
END;
$$ LANGUAGE plpgsql;

-- Function to get token statistics with USD values
CREATE OR REPLACE FUNCTION get_token_stats_with_usd(p_token_id UUID)
RETURNS TABLE (
    token_id UUID,
    latest_price_sol NUMERIC,
    latest_price_usd NUMERIC,
    volume_24h_sol NUMERIC,
    volume_24h_usd NUMERIC,
    high_24h_sol NUMERIC,
    high_24h_usd NUMERIC,
    low_24h_sol NUMERIC,
    low_24h_usd NUMERIC,
    price_change_24h_pct NUMERIC,
    last_updated TIMESTAMPTZ
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
        WHERE token_id = p_token_id
            AND bucket <= NOW() - INTERVAL '24 hours'
        ORDER BY bucket DESC
        LIMIT 1
    )
    SELECT 
        ld.token_id,
        ld.latest_price_sol,
        ld.latest_price_usd,
        COALESCE(s.volume_24h_sol, 0),
        COALESCE(s.volume_24h_usd, 0),
        COALESCE(s.high_24h_sol, ld.latest_price_sol),
        COALESCE(s.high_24h_usd, ld.latest_price_usd),
        COALESCE(s.low_24h_sol, ld.latest_price_sol),
        COALESCE(s.low_24h_usd, ld.latest_price_usd),
        CASE 
            WHEN p24.price_24h_ago > 0 THEN 
                ((ld.latest_price_sol - p24.price_24h_ago) / p24.price_24h_ago) * 100
            ELSE 0
        END as price_change_24h_pct,
        ld.last_updated
    FROM latest_data ld
    LEFT JOIN stats_24h s ON ld.token_id = s.token_id
    CROSS JOIN price_24h_ago p24;
END;
$$ LANGUAGE plpgsql;

-- Materialized view for top tokens by USD volume
CREATE MATERIALIZED VIEW IF NOT EXISTS top_tokens_by_usd_volume AS
SELECT 
    t.id as token_id,
    t.name,
    t.symbol,
    t.mint_address,
    SUM(pc.volume_sol * get_sol_usd_price(pc.bucket)) as volume_24h_usd,
    MAX(pc.close * get_sol_usd_price(pc.bucket)) as latest_price_usd,
    COUNT(DISTINCT DATE_TRUNC('hour', pc.bucket)) as active_hours
FROM tokens t
JOIN price_candles_1m pc ON t.id = pc.token_id
WHERE pc.bucket > NOW() - INTERVAL '24 hours'
GROUP BY t.id, t.name, t.symbol, t.mint_address
HAVING SUM(pc.volume_sol) > 0
ORDER BY volume_24h_usd DESC;

-- Create index on the materialized view
CREATE INDEX IF NOT EXISTS idx_top_tokens_volume_usd ON top_tokens_by_usd_volume(volume_24h_usd DESC);

-- Function to refresh top tokens view
CREATE OR REPLACE FUNCTION refresh_top_tokens_usd()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY top_tokens_by_usd_volume;
END;
$$ LANGUAGE plpgsql;

-- Enhanced price aggregate with USD values
CREATE OR REPLACE FUNCTION get_price_candles_with_usd(
    p_token_id UUID,
    p_interval TEXT DEFAULT '1 minute',
    p_start_time TIMESTAMPTZ DEFAULT NOW() - INTERVAL '24 hours',
    p_end_time TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
    bucket TIMESTAMPTZ,
    open_sol NUMERIC,
    high_sol NUMERIC,
    low_sol NUMERIC,
    close_sol NUMERIC,
    volume_sol NUMERIC,
    open_usd NUMERIC,
    high_usd NUMERIC,
    low_usd NUMERIC,
    close_usd NUMERIC,
    volume_usd NUMERIC,
    trades INT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        time_bucket(p_interval::INTERVAL, pc.bucket) as bucket,
        first(pc.open, pc.bucket) as open_sol,
        max(pc.high) as high_sol,
        min(pc.low) as low_sol,
        last(pc.close, pc.bucket) as close_sol,
        sum(pc.volume_sol) as volume_sol,
        first(pc.open * get_sol_usd_price(pc.bucket), pc.bucket) as open_usd,
        max(pc.high * get_sol_usd_price(pc.bucket)) as high_usd,
        min(pc.low * get_sol_usd_price(pc.bucket)) as low_usd,
        last(pc.close * get_sol_usd_price(pc.bucket), pc.bucket) as close_usd,
        sum(pc.volume_sol * get_sol_usd_price(pc.bucket)) as volume_usd,
        sum(pc.trade_count)::INT as trades
    FROM price_candles_1m pc
    WHERE pc.token_id = p_token_id
        AND pc.bucket >= p_start_time
        AND pc.bucket < p_end_time
    GROUP BY time_bucket(p_interval::INTERVAL, pc.bucket)
    ORDER BY bucket;
END;
$$ LANGUAGE plpgsql;

-- Function to get portfolio value in USD
CREATE OR REPLACE FUNCTION calculate_portfolio_value_usd(
    p_wallet_address TEXT,
    p_token_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
    token_id UUID,
    token_symbol TEXT,
    balance NUMERIC,
    price_sol NUMERIC,
    price_usd NUMERIC,
    value_sol NUMERIC,
    value_usd NUMERIC
) AS $$
BEGIN
    -- This is a placeholder - would need wallet balance tracking
    -- For now, returns empty result set
    RETURN;
END;
$$ LANGUAGE plpgsql;

-- View for monitoring USD calculation health
CREATE OR REPLACE VIEW usd_calculation_health AS
WITH recent_transactions AS (
    SELECT 
        COUNT(*) as total_transactions,
        COUNT(price_per_token_usd) as transactions_with_usd,
        MIN(block_time) as oldest_transaction,
        MAX(block_time) as newest_transaction
    FROM transactions
    WHERE block_time > NOW() - INTERVAL '1 hour'
),
recent_candles AS (
    SELECT 
        COUNT(*) as total_candles,
        COUNT(open_usd) as candles_with_usd,
        MIN(bucket) as oldest_candle,
        MAX(bucket) as newest_candle
    FROM price_candles_1m
    WHERE bucket > NOW() - INTERVAL '1 hour'
)
SELECT 
    rt.total_transactions,
    rt.transactions_with_usd,
    ROUND((rt.transactions_with_usd::NUMERIC / NULLIF(rt.total_transactions, 0)) * 100, 2) as transaction_usd_coverage_pct,
    rc.total_candles,
    rc.candles_with_usd,
    ROUND((rc.candles_with_usd::NUMERIC / NULLIF(rc.total_candles, 0)) * 100, 2) as candle_usd_coverage_pct,
    rt.newest_transaction as last_transaction,
    rc.newest_candle as last_candle
FROM recent_transactions rt
CROSS JOIN recent_candles rc;

-- Grant permissions
GRANT SELECT ON top_tokens_by_usd_volume TO PUBLIC;
GRANT SELECT ON usd_calculation_health TO PUBLIC;
GRANT EXECUTE ON FUNCTION update_price_candle_usd_values TO PUBLIC;
GRANT EXECUTE ON FUNCTION get_token_stats_with_usd TO PUBLIC;
GRANT EXECUTE ON FUNCTION get_price_candles_with_usd TO PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_top_tokens_usd TO PUBLIC;