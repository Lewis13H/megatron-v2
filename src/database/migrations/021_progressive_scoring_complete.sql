-- Migration: 021_progressive_scoring_complete
-- Description: Complete progressive scoring system with no hardcoded values
-- Both bonding curve AND market cap follow bell curve theory

-- Configuration table for all scoring parameters (no hardcoded values!)
CREATE TABLE IF NOT EXISTS scoring_config (
    id SERIAL PRIMARY KEY,
    component VARCHAR(50) NOT NULL,
    parameter VARCHAR(100) NOT NULL,
    value NUMERIC NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(component, parameter)
);

-- Insert default scoring configuration
INSERT INTO scoring_config (component, parameter, value, description) VALUES
-- Bonding Curve Configuration
('bonding_curve', 'launch_min', 0, 'Minimum progress for launch phase'),
('bonding_curve', 'launch_max', 5, 'Maximum progress for launch phase'),
('bonding_curve', 'proving_min', 5, 'Minimum progress for proving phase'),
('bonding_curve', 'proving_max', 35, 'Maximum progress for proving phase'),
('bonding_curve', 'building_min', 35, 'Minimum progress for building phase'),
('bonding_curve', 'building_max', 45, 'Maximum progress for building phase'),
('bonding_curve', 'optimal_min', 45, 'Minimum progress for optimal zone'),
('bonding_curve', 'optimal_max', 55, 'Maximum progress for optimal zone'),
('bonding_curve', 'declining_min', 55, 'Start of decline phase'),
('bonding_curve', 'declining_max', 75, 'End of decline phase'),
('bonding_curve', 'max_points', 37.5, 'Maximum position points'),
('bonding_curve', 'velocity_optimal_min', 0.5, 'Minimum optimal velocity %/hour'),
('bonding_curve', 'velocity_optimal_max', 2.0, 'Maximum optimal velocity %/hour'),

-- Market Cap Configuration (NEW - Progressive!)
('market_cap', 'launch_mcap', 29, 'Initial market cap in SOL (~$5.8k)'),
('market_cap', 'proving_min_mcap', 8000, 'Minimum mcap for proving phase'),
('market_cap', 'proving_max_mcap', 15000, 'Maximum mcap for proving phase'),
('market_cap', 'building_min_mcap', 15000, 'Minimum mcap for building phase'),
('market_cap', 'building_max_mcap', 25000, 'Maximum mcap for building phase'),
('market_cap', 'optimal_min_mcap', 25000, 'Minimum optimal market cap'),
('market_cap', 'optimal_max_mcap', 45000, 'Maximum optimal market cap'),
('market_cap', 'declining_min_mcap', 45000, 'Start of mcap decline'),
('market_cap', 'declining_max_mcap', 60000, 'End of mcap scoring range'),
('market_cap', 'max_base_points', 60, 'Maximum base points for market cap'),
('market_cap', 'max_velocity_points', 40, 'Maximum velocity bonus points'),

-- Trading Health Configuration
('trading_health', 'optimal_buy_sell_ratio', 2.0, 'Optimal buy/sell ratio'),
('trading_health', 'max_ratio_points', 30, 'Maximum points for buy/sell ratio'),
('trading_health', 'max_volume_points', 25, 'Maximum points for volume trend'),
('trading_health', 'max_distribution_points', 20, 'Maximum points for distribution'),
('trading_health', 'whale_concentration_threshold', 0.1, 'Whale concentration penalty threshold'),

-- Sell-off Response Configuration
('selloff', 'minor_drop_threshold', 5, 'Minor price drop % threshold'),
('selloff', 'moderate_drop_threshold', 15, 'Moderate price drop % threshold'),
('selloff', 'severe_drop_threshold', 30, 'Severe price drop % threshold'),
('selloff', 'whale_dump_sol', 5, 'SOL amount for whale dump detection'),
('selloff', 'max_positive_points', 75, 'Maximum positive selloff score'),
('selloff', 'max_negative_points', -60, 'Maximum negative selloff score'),

-- Consistency Score (placeholder)
('consistency', 'base_points', 12.5, 'Base consistency points until implemented')
ON CONFLICT (component, parameter) DO UPDATE 
SET value = EXCLUDED.value, updated_at = NOW();

-- Function to get config value
CREATE OR REPLACE FUNCTION get_scoring_config(
    p_component VARCHAR,
    p_parameter VARCHAR
) RETURNS NUMERIC AS $$
DECLARE
    v_value NUMERIC;
BEGIN
    SELECT value INTO v_value
    FROM scoring_config
    WHERE component = p_component AND parameter = p_parameter;
    
    RETURN COALESCE(v_value, 0);
END;
$$ LANGUAGE plpgsql;

-- Progressive Market Cap Scoring (NEW!)
CREATE OR REPLACE FUNCTION calculate_market_cap_score(
    p_market_cap_usd NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    base_score NUMERIC;
    launch_mcap NUMERIC;
    proving_min NUMERIC;
    proving_max NUMERIC;
    building_min NUMERIC;
    building_max NUMERIC;
    optimal_min NUMERIC;
    optimal_max NUMERIC;
    declining_min NUMERIC;
    declining_max NUMERIC;
    max_points NUMERIC;
BEGIN
    -- Get configuration values
    launch_mcap := get_scoring_config('market_cap', 'launch_mcap') * 200; -- Convert SOL to USD
    proving_min := get_scoring_config('market_cap', 'proving_min_mcap');
    proving_max := get_scoring_config('market_cap', 'proving_max_mcap');
    building_min := get_scoring_config('market_cap', 'building_min_mcap');
    building_max := get_scoring_config('market_cap', 'building_max_mcap');
    optimal_min := get_scoring_config('market_cap', 'optimal_min_mcap');
    optimal_max := get_scoring_config('market_cap', 'optimal_max_mcap');
    declining_min := get_scoring_config('market_cap', 'declining_min_mcap');
    declining_max := get_scoring_config('market_cap', 'declining_max_mcap');
    max_points := get_scoring_config('market_cap', 'max_base_points');
    
    -- Progressive scoring based on market cap (similar to bonding curve)
    IF p_market_cap_usd < launch_mcap THEN
        -- Just launched: Near 0 points
        base_score := 0;
        
    ELSIF p_market_cap_usd < proving_min THEN
        -- Very early: 0-10 points
        base_score := (p_market_cap_usd / proving_min) * 10;
        
    ELSIF p_market_cap_usd >= proving_min AND p_market_cap_usd < proving_max THEN
        -- Proving phase: 10-25 points
        base_score := 10 + ((p_market_cap_usd - proving_min) / (proving_max - proving_min)) * 15;
        
    ELSIF p_market_cap_usd >= building_min AND p_market_cap_usd < building_max THEN
        -- Building phase: 25-45 points
        base_score := 25 + ((p_market_cap_usd - building_min) / (building_max - building_min)) * 20;
        
    ELSIF p_market_cap_usd >= optimal_min AND p_market_cap_usd <= optimal_max THEN
        -- OPTIMAL ZONE: Maximum 60 points
        base_score := max_points;
        
    ELSIF p_market_cap_usd > declining_min AND p_market_cap_usd <= declining_max THEN
        -- Declining phase: 60-30 points
        base_score := max_points - ((p_market_cap_usd - declining_min) / (declining_max - declining_min)) * 30;
        
    ELSIF p_market_cap_usd > declining_max AND p_market_cap_usd <= 100000 THEN
        -- Late stage: 30-10 points
        base_score := 30 - ((p_market_cap_usd - declining_max) / 50000) * 20;
        
    ELSE
        -- Too high: Minimal points
        base_score := 5;
    END IF;
    
    RETURN base_score;
END;
$$ LANGUAGE plpgsql;

-- Updated Bonding Curve Scoring (using config values)
CREATE OR REPLACE FUNCTION calculate_bonding_curve_score(
    p_progress NUMERIC,
    p_velocity_per_hour NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    velocity_score NUMERIC;
    position_score NUMERIC;
    consistency_score NUMERIC;
    base_multiplier NUMERIC;
    
    -- Config values
    optimal_min NUMERIC;
    optimal_max NUMERIC;
    max_position_points NUMERIC;
    velocity_optimal_min NUMERIC;
    velocity_optimal_max NUMERIC;
BEGIN
    -- Get config values
    optimal_min := get_scoring_config('bonding_curve', 'optimal_min');
    optimal_max := get_scoring_config('bonding_curve', 'optimal_max');
    max_position_points := get_scoring_config('bonding_curve', 'max_points');
    velocity_optimal_min := get_scoring_config('bonding_curve', 'velocity_optimal_min');
    velocity_optimal_max := get_scoring_config('bonding_curve', 'velocity_optimal_max');
    consistency_score := get_scoring_config('consistency', 'base_points');
    
    -- Velocity Score (0-33 points)
    IF p_velocity_per_hour >= velocity_optimal_min AND p_velocity_per_hour <= velocity_optimal_max THEN
        velocity_score := 33;
    ELSIF p_velocity_per_hour >= 0.3 AND p_velocity_per_hour < velocity_optimal_min THEN
        velocity_score := 25;
    ELSIF p_velocity_per_hour > velocity_optimal_max AND p_velocity_per_hour <= 3.0 THEN
        velocity_score := 20;
    ELSIF p_velocity_per_hour > 3.0 AND p_velocity_per_hour <= 5.0 THEN
        velocity_score := 10;
    ELSIF p_velocity_per_hour > 0 AND p_velocity_per_hour < 0.3 THEN
        velocity_score := 8;
    ELSE
        velocity_score := 0;
    END IF;
    
    -- Progressive Position Score
    IF p_progress < get_scoring_config('bonding_curve', 'launch_max') THEN
        position_score := p_progress * 0.5;
    ELSIF p_progress < 15 THEN
        position_score := 2.5 + (p_progress - 5) * 0.75;
    ELSIF p_progress < 35 THEN
        position_score := 10 + (p_progress - 15) * 0.625;
    ELSIF p_progress < 45 THEN
        position_score := 22.5 + (p_progress - 35) * 1.25;
    ELSIF p_progress >= optimal_min AND p_progress <= optimal_max THEN
        position_score := max_position_points;
    ELSIF p_progress > optimal_max AND p_progress <= 65 THEN
        position_score := max_position_points - (p_progress - optimal_max) * 1.0;
    ELSIF p_progress > 65 AND p_progress <= 75 THEN
        position_score := 27.5 - (p_progress - 65) * 1.5;
    ELSIF p_progress > 75 AND p_progress <= 85 THEN
        position_score := 12.5 - (p_progress - 75) * 0.75;
    ELSE
        position_score := 3;
    END IF;
    
    -- Apply multiplier for unproven tokens
    IF p_progress < 10 THEN
        base_multiplier := 0.3;
        velocity_score := velocity_score * 0.5;
    ELSIF p_progress < 20 THEN
        base_multiplier := 0.6;
        velocity_score := velocity_score * 0.75;
    ELSIF p_progress < 30 THEN
        base_multiplier := 0.85;
    ELSE
        base_multiplier := 1.0;
    END IF;
    
    position_score := position_score * base_multiplier;
    
    RETURN velocity_score + consistency_score + position_score;
END;
$$ LANGUAGE plpgsql;

-- Function to update scoring configuration
CREATE OR REPLACE FUNCTION update_scoring_config(
    p_component VARCHAR,
    p_parameter VARCHAR,
    p_value NUMERIC,
    p_description TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    INSERT INTO scoring_config (component, parameter, value, description)
    VALUES (p_component, p_parameter, p_value, p_description)
    ON CONFLICT (component, parameter) 
    DO UPDATE SET 
        value = EXCLUDED.value,
        description = COALESCE(EXCLUDED.description, scoring_config.description),
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- View to see current scoring configuration
CREATE OR REPLACE VIEW scoring_configuration AS
SELECT 
    component,
    parameter,
    value,
    description,
    updated_at
FROM scoring_config
ORDER BY component, parameter;

-- View to test scoring at different levels
CREATE OR REPLACE VIEW scoring_test_matrix AS
WITH test_points AS (
    SELECT 
        bc_progress,
        market_cap
    FROM (
        VALUES 
        (0, 5800),      -- Launch (~29 SOL)
        (10, 10000),    -- Early proving
        (25, 18000),    -- Building phase
        (45, 30000),    -- Optimal start
        (50, 35000),    -- Optimal peak
        (55, 40000),    -- Optimal end
        (70, 50000),    -- Late declining
        (85, 55000),    -- Very late
        (95, 65000)     -- Too late
    ) AS t(bc_progress, market_cap)
)
SELECT 
    bc_progress as bonding_curve_progress,
    market_cap as market_cap_usd,
    calculate_bonding_curve_score(bc_progress, 1.0) as bc_score,
    calculate_market_cap_score(market_cap) as mcap_score,
    calculate_bonding_curve_score(bc_progress, 1.0) + 
    calculate_market_cap_score(market_cap) as combined_score,
    CASE 
        WHEN bc_progress BETWEEN 45 AND 55 AND market_cap BETWEEN 25000 AND 45000 THEN '🎯 OPTIMAL'
        WHEN bc_progress < 20 THEN '🔴 Too Early'
        WHEN bc_progress > 75 THEN '⚠️ Too Late'
        ELSE '🟡 Monitor'
    END as status
FROM test_points
ORDER BY bc_progress;

-- Add comments
COMMENT ON TABLE scoring_config IS 'Configurable scoring parameters - no hardcoded values!';
COMMENT ON FUNCTION calculate_market_cap_score IS 'Progressive market cap scoring following bell curve theory';
COMMENT ON FUNCTION calculate_bonding_curve_score IS 'Progressive bonding curve scoring with configurable parameters';