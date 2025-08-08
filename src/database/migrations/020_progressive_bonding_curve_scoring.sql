-- Migration: 020_progressive_bonding_curve_scoring
-- Description: Implement progressive scoring curve that starts at 0 and peaks at 50-55%
-- Based on the principle that tokens need to prove themselves before scoring high

-- Drop the old function
DROP FUNCTION IF EXISTS calculate_bonding_curve_score(NUMERIC, NUMERIC);

-- Create new progressive bonding curve scoring function
CREATE OR REPLACE FUNCTION calculate_bonding_curve_score(
    p_progress NUMERIC,
    p_velocity_per_hour NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    velocity_score NUMERIC;
    position_score NUMERIC;
    consistency_score NUMERIC := 12.5; -- Placeholder for stability metrics
    base_multiplier NUMERIC;
BEGIN
    -- Progress Velocity Score (0-33 points)
    -- Same as before - rewards steady growth
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
    
    -- Progressive Position Score (0-37.5 points)
    -- Implements the bell curve from your graph
    IF p_progress < 5 THEN
        -- Near launch: Start at 0, tiny increase
        position_score := p_progress * 0.5; -- 0 to 2.5 points
        
    ELSIF p_progress >= 5 AND p_progress < 15 THEN
        -- Early stage: Slow linear growth
        position_score := 2.5 + (p_progress - 5) * 0.75; -- 2.5 to 10 points
        
    ELSIF p_progress >= 15 AND p_progress < 35 THEN
        -- Building momentum: Moderate growth
        position_score := 10 + (p_progress - 15) * 0.625; -- 10 to 22.5 points
        
    ELSIF p_progress >= 35 AND p_progress < 45 THEN
        -- Approaching optimal: Steep climb
        position_score := 22.5 + (p_progress - 35) * 1.25; -- 22.5 to 35 points
        
    ELSIF p_progress >= 45 AND p_progress <= 55 THEN
        -- OPTIMAL ZONE: Maximum points
        position_score := 37.5; -- Peak score
        
    ELSIF p_progress > 55 AND p_progress <= 65 THEN
        -- Post-peak: Gradual decline
        position_score := 37.5 - (p_progress - 55) * 1.0; -- 37.5 to 27.5 points
        
    ELSIF p_progress > 65 AND p_progress <= 75 THEN
        -- Late stage: Steeper decline
        position_score := 27.5 - (p_progress - 65) * 1.5; -- 27.5 to 12.5 points
        
    ELSIF p_progress > 75 AND p_progress <= 85 THEN
        -- Near graduation: Flatten near bottom
        position_score := 12.5 - (p_progress - 75) * 0.75; -- 12.5 to 5 points
        
    ELSE
        -- Too late: Minimal score
        position_score := 3; -- Floor value
    END IF;
    
    -- Apply a multiplier based on whether token has "proven itself"
    -- This further suppresses scores for very new tokens
    IF p_progress < 10 THEN
        base_multiplier := 0.3; -- Heavy penalty for unproven tokens
    ELSIF p_progress < 20 THEN
        base_multiplier := 0.6; -- Still proving itself
    ELSIF p_progress < 30 THEN
        base_multiplier := 0.85; -- Getting established
    ELSE
        base_multiplier := 1.0; -- Fully proven
    END IF;
    
    -- Apply the multiplier to position score
    position_score := position_score * base_multiplier;
    
    -- Also reduce velocity score for very early tokens
    IF p_progress < 10 THEN
        velocity_score := velocity_score * 0.5;
    ELSIF p_progress < 20 THEN
        velocity_score := velocity_score * 0.75;
    END IF;
    
    RETURN velocity_score + consistency_score + position_score;
END;
$$ LANGUAGE plpgsql;

-- Add comment explaining the progressive scoring logic
COMMENT ON FUNCTION calculate_bonding_curve_score(NUMERIC, NUMERIC) IS 
'Progressive bonding curve scoring (0-83 points) that starts at ~0 for new tokens.
- 0-5%: Near 0 points (unproven)
- 5-35%: Gradual increase (proving phase)  
- 35-45%: Steep climb (momentum building)
- 45-55%: Maximum 37.5 points (optimal entry)
- 55-75%: Gradual decline (late stage)
- 75%+: Minimal points (graduation risk)

Velocity and consistency add up to 45.5 additional points.
Total maximum: 83 points at 50-55% progress with good velocity.';

-- Create a view to show the scoring curve for visualization
CREATE OR REPLACE VIEW bonding_curve_scoring_curve AS
WITH progress_points AS (
    SELECT 
        generate_series(0, 100, 5) as progress
)
SELECT 
    progress as bonding_curve_progress,
    calculate_bonding_curve_score(progress, 1.0) as score_with_normal_velocity,
    calculate_bonding_curve_score(progress, 0.0) as score_with_no_velocity,
    calculate_bonding_curve_score(progress, 2.0) as score_with_high_velocity,
    CASE 
        WHEN progress < 5 THEN 'Launch Phase'
        WHEN progress < 35 THEN 'Proving Phase'
        WHEN progress < 45 THEN 'Momentum Building'
        WHEN progress <= 55 THEN '🎯 OPTIMAL ENTRY'
        WHEN progress <= 75 THEN 'Late Stage'
        ELSE 'Graduation Risk'
    END as phase
FROM progress_points
ORDER BY progress;

-- Update the optimal entry zone function to match new curve
CREATE OR REPLACE FUNCTION is_in_optimal_entry_zone(
    p_progress NUMERIC,
    p_market_cap_usd NUMERIC
) RETURNS BOOLEAN AS $$
BEGIN
    -- Optimal zone is now 45-55% progress with $15-25k market cap
    RETURN (p_progress >= 45 AND p_progress <= 55) 
        AND (p_market_cap_usd >= 15000 AND p_market_cap_usd <= 25000);
END;
$$ LANGUAGE plpgsql;

-- Create monitoring function to track score progression
CREATE OR REPLACE FUNCTION get_token_score_progression(
    p_token_id UUID
) RETURNS TABLE (
    score_timestamp TIMESTAMPTZ,
    bonding_curve_progress NUMERIC,
    technical_score NUMERIC,
    market_cap_usd NUMERIC,
    phase TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ts.calculated_at as score_timestamp,
        ts.bonding_curve_progress,
        ts.total_score as technical_score,
        ts.market_cap_usd,
        CASE 
            WHEN ts.bonding_curve_progress < 5 THEN 'Launch'
            WHEN ts.bonding_curve_progress < 35 THEN 'Proving'
            WHEN ts.bonding_curve_progress < 45 THEN 'Building'
            WHEN ts.bonding_curve_progress <= 55 THEN 'OPTIMAL'
            WHEN ts.bonding_curve_progress <= 75 THEN 'Late'
            ELSE 'Graduation'
        END as phase
    FROM technical_scores ts
    WHERE ts.token_id = p_token_id
    ORDER BY ts.calculated_at DESC
    LIMIT 100;
END;
$$ LANGUAGE plpgsql;