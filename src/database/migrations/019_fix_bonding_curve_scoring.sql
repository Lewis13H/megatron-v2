-- Migration: 019_fix_bonding_curve_scoring
-- Description: Adjust bonding curve scoring to favor 40-80% range per trading thesis
-- This aligns with the entry strategy defined in pump-fun-trading-thesis.md

-- Drop the old function
DROP FUNCTION IF EXISTS calculate_bonding_curve_score(NUMERIC, NUMERIC);

-- Create improved bonding curve scoring function (0-83 points)
CREATE OR REPLACE FUNCTION calculate_bonding_curve_score(
    p_progress NUMERIC,
    p_velocity_per_hour NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    velocity_score NUMERIC;
    consistency_score NUMERIC := 12.5; -- Default, needs historical data for full implementation
    position_score NUMERIC;
BEGIN
    -- Progress Velocity Score (0-33 points)
    -- Optimal: 0.5-2% per hour as per thesis
    IF p_velocity_per_hour >= 0.5 AND p_velocity_per_hour <= 2.0 THEN
        velocity_score := 33;  -- Perfect velocity range
    ELSIF p_velocity_per_hour >= 0.3 AND p_velocity_per_hour < 0.5 THEN
        velocity_score := 25;  -- Slightly slow but acceptable
    ELSIF p_velocity_per_hour > 2.0 AND p_velocity_per_hour <= 3.0 THEN
        velocity_score := 20;  -- Fast but manageable
    ELSIF p_velocity_per_hour > 3.0 AND p_velocity_per_hour <= 5.0 THEN
        velocity_score := 10;  -- Too fast, risky
    ELSIF p_velocity_per_hour > 0 AND p_velocity_per_hour < 0.3 THEN
        velocity_score := 8;   -- Too slow, may stall
    ELSE
        velocity_score := 0;   -- No movement or negative
    END IF;
    
    -- Progress Position Score (0-37.5 points) - ADJUSTED FOR 40-80% OPTIMAL RANGE
    -- Per thesis: Entry at 40% minimum, optimal accumulation 40-80%
    IF p_progress >= 40 AND p_progress <= 80 THEN
        -- OPTIMAL ZONE: This is where the thesis wants us to enter and accumulate
        IF p_progress >= 40 AND p_progress <= 60 THEN
            position_score := 37.5;  -- Sweet spot for entry and accumulation
        ELSE -- 60-80%
            position_score := 32;    -- Still good but approaching graduation
        END IF;
    ELSIF p_progress >= 30 AND p_progress < 40 THEN
        position_score := 25;  -- Close to optimal, consider early entry
    ELSIF p_progress > 80 AND p_progress <= 90 THEN
        position_score := 15;  -- Late entry, graduation risk
    ELSIF p_progress >= 20 AND p_progress < 30 THEN
        position_score := 12;  -- Too early but showing promise
    ELSIF p_progress > 90 THEN
        position_score := 5;   -- Too late, about to graduate
    ELSIF p_progress >= 10 AND p_progress < 20 THEN
        position_score := 8;   -- Very early, high risk
    ELSIF p_progress >= 5 AND p_progress < 10 THEN
        position_score := 5;   -- Extremely early
    ELSE
        position_score := 2;   -- Just launched, maximum risk
    END IF;
    
    -- Consistency Score remains at 12.5 (requires historical analysis)
    -- This could be enhanced with actual progress stability metrics
    
    RETURN velocity_score + consistency_score + position_score;
END;
$$ LANGUAGE plpgsql;

-- Add comment explaining the scoring logic
COMMENT ON FUNCTION calculate_bonding_curve_score(NUMERIC, NUMERIC) IS 
'Calculates bonding curve score (0-83 points) optimized for 40-80% progress range per trading thesis.
Velocity: 33 points max for 0.5-2% per hour
Position: 37.5 points max for 40-60% progress (optimal entry zone)
Consistency: 12.5 points (placeholder for stability metrics)
Total: 83 points maximum';

-- Create a helper function to identify tokens in optimal entry zone
CREATE OR REPLACE FUNCTION is_in_optimal_entry_zone(
    p_progress NUMERIC,
    p_market_cap_usd NUMERIC
) RETURNS BOOLEAN AS $$
BEGIN
    -- Per thesis: Entry at $15k market cap, 40% bonding curve minimum
    -- Accumulation range: $15k-$25k market cap, 40-80% progress
    RETURN (p_progress >= 40 AND p_progress <= 80) 
        AND (p_market_cap_usd >= 15000 AND p_market_cap_usd <= 25000);
END;
$$ LANGUAGE plpgsql;

-- Create view for tokens currently in optimal entry zone
CREATE OR REPLACE VIEW optimal_entry_tokens AS
SELECT 
    t.symbol,
    t.name,
    t.mint_address,
    p.bonding_curve_progress,
    p.latest_price_usd * 1000000000 as market_cap_usd,
    ts.total_score as technical_score,
    hs.total_score as holder_score,
    (COALESCE(ts.total_score, 0) + COALESCE(hs.total_score, 0)) as combined_score,
    CASE 
        WHEN (COALESCE(ts.total_score, 0) + COALESCE(hs.total_score, 0)) >= 600 THEN 'MAXIMUM'
        WHEN (COALESCE(ts.total_score, 0) + COALESCE(hs.total_score, 0)) >= 500 THEN 'HIGH'
        WHEN (COALESCE(ts.total_score, 0) + COALESCE(hs.total_score, 0)) >= 400 THEN 'MEDIUM'
        WHEN (COALESCE(ts.total_score, 0) + COALESCE(hs.total_score, 0)) >= 300 THEN 'LOW'
        ELSE 'NO_ENTRY'
    END as position_size_recommendation,
    p.updated_at as last_updated
FROM tokens t
JOIN pools p ON t.id = p.token_id
LEFT JOIN LATERAL (
    SELECT total_score 
    FROM technical_scores 
    WHERE token_id = t.id 
    ORDER BY calculated_at DESC 
    LIMIT 1
) ts ON true
LEFT JOIN LATERAL (
    SELECT total_score 
    FROM holder_scores_v2 
    WHERE token_id = t.id 
    ORDER BY score_time DESC 
    LIMIT 1
) hs ON true
WHERE p.status = 'active'
    AND p.platform = 'pumpfun'
    AND is_in_optimal_entry_zone(
        p.bonding_curve_progress, 
        p.latest_price_usd * 1000000000
    )
ORDER BY combined_score DESC;

-- Add index to support the view
CREATE INDEX IF NOT EXISTS idx_pools_bonding_curve_active 
    ON pools(bonding_curve_progress, latest_price_usd) 
    WHERE status = 'active' AND platform = 'pumpfun';