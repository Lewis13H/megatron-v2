-- Migration: 024_dynamic_holder_frequency
-- Description: Ultra-dynamic holder analysis frequency based on combined technical + holder scores
-- Critical tokens can be analyzed as frequently as every 30 seconds

-- Add columns for dynamic frequency management
ALTER TABLE tokens
ADD COLUMN IF NOT EXISTS combined_score DECIMAL(6,1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS score_momentum DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS analysis_tier VARCHAR(20) DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS min_analysis_interval INT DEFAULT 30,
ADD COLUMN IF NOT EXISTS last_technical_score DECIMAL(5,1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS technical_score_time TIMESTAMPTZ;

-- Create index for ultra-fast tier queries
CREATE INDEX IF NOT EXISTS idx_tokens_analysis_tier ON tokens(analysis_tier, next_holder_analysis)
WHERE platform = 'pumpfun';

-- Dynamic frequency calculation based on BOTH technical and holder scores
CREATE OR REPLACE FUNCTION calculate_dynamic_frequency(
    p_token_id UUID
) RETURNS TABLE (
    frequency_seconds INT,
    analysis_tier VARCHAR(20),
    priority_score INT,
    reason TEXT
) AS $$
DECLARE
    v_token RECORD;
    v_technical_score DECIMAL(5,1);
    v_holder_score DECIMAL(5,1);
    v_combined_score DECIMAL(6,1);
    v_frequency INT;
    v_tier VARCHAR(20);
    v_priority INT := 0;
    v_reason TEXT := '';
    v_score_momentum DECIMAL(10,2);
BEGIN
    -- Get token and scores
    SELECT 
        t.*,
        p.bonding_curve_progress,
        p.latest_price
    INTO v_token
    FROM tokens t
    LEFT JOIN pools p ON p.token_id = t.id
    WHERE t.id = p_token_id;
    
    -- Get latest technical score
    SELECT total_score INTO v_technical_score
    FROM technical_scores
    WHERE token_id = p_token_id
    ORDER BY score_time DESC
    LIMIT 1;
    
    -- Get latest holder score
    SELECT total_score INTO v_holder_score
    FROM holder_scores_v2
    WHERE token_id = p_token_id
    ORDER BY score_time DESC
    LIMIT 1;
    
    -- Calculate combined score (666 max)
    v_combined_score := COALESCE(v_technical_score, 0) + COALESCE(v_holder_score, 0);
    
    -- Calculate score momentum (rate of change)
    IF v_token.combined_score > 0 THEN
        v_score_momentum := ABS(v_combined_score - v_token.combined_score) / v_token.combined_score * 100;
    ELSE
        v_score_momentum := 0;
    END IF;
    
    -- ULTRA CRITICAL TIER (30 seconds - 1 minute)
    IF v_combined_score >= 500 OR 
       (v_combined_score >= 400 AND v_score_momentum > 20) OR
       (v_technical_score >= 280 AND v_token.bonding_curve_progress BETWEEN 15 AND 40) THEN
        v_frequency := 30;  -- 30 seconds!
        v_tier := 'ultra_critical';
        v_priority := 1000;
        v_reason := 'Exceptional scores or high momentum';
        
    -- CRITICAL TIER (1-2 minutes)
    ELSIF v_combined_score >= 400 OR
          (v_combined_score >= 350 AND v_score_momentum > 15) OR
          (v_technical_score >= 250 AND v_holder_score >= 150) THEN
        v_frequency := 60;  -- 1 minute
        v_tier := 'critical';
        v_priority := 800;
        v_reason := 'Very high combined scores';
        
    -- HIGH PRIORITY TIER (2-3 minutes)
    ELSIF v_combined_score >= 350 OR
          (v_combined_score >= 300 AND v_score_momentum > 10) OR
          (v_technical_score >= 200 AND v_token.bonding_curve_progress BETWEEN 10 AND 50) THEN
        v_frequency := 120;  -- 2 minutes
        v_tier := 'high_priority';
        v_priority := 600;
        v_reason := 'High scores in sweet spot';
        
    -- ELEVATED TIER (3-5 minutes)
    ELSIF v_combined_score >= 300 OR
          v_technical_score >= 180 THEN
        v_frequency := 180;  -- 3 minutes
        v_tier := 'elevated';
        v_priority := 400;
        v_reason := 'Good scores';
        
    -- STANDARD TIER (5-10 minutes)
    ELSIF v_combined_score >= 200 OR
          v_token.bonding_curve_progress BETWEEN 15 AND 40 THEN
        v_frequency := 300;  -- 5 minutes
        v_tier := 'standard';
        v_priority := 200;
        v_reason := 'Average scores in range';
        
    -- LOW PRIORITY TIER (10-30 minutes)
    ELSIF v_combined_score >= 100 THEN
        v_frequency := 600;  -- 10 minutes
        v_tier := 'low_priority';
        v_priority := 100;
        v_reason := 'Below average scores';
        
    -- MINIMAL TIER (30-60 minutes)
    ELSE
        v_frequency := 1800;  -- 30 minutes
        v_tier := 'minimal';
        v_priority := 50;
        v_reason := 'Low scores or inactive';
    END IF;
    
    -- SPECIAL ADJUSTMENTS
    
    -- Note: Price change and volume overrides disabled until columns are added
    -- These can be enabled once price_change_5m_percent and volume columns exist
    
    -- Graduation approaching override (70-84% progress)
    IF v_token.bonding_curve_progress BETWEEN 70 AND 84 AND v_frequency > 60 THEN
        v_frequency := 60;
        v_tier := 'critical';
        v_priority := v_priority + 300;
        v_reason := v_reason || ' + near graduation';
    END IF;
    
    -- Recent analysis penalty (prevent spam)
    IF v_token.last_holder_analysis IS NOT NULL THEN
        IF v_token.last_holder_analysis > NOW() - INTERVAL '30 seconds' AND v_tier != 'ultra_critical' THEN
            v_frequency := GREATEST(v_frequency, 60);
        END IF;
    END IF;
    
    RETURN QUERY SELECT v_frequency, v_tier, v_priority, v_reason;
END;
$$ LANGUAGE plpgsql;

-- Enhanced token selection with ultra-fast tiers
CREATE OR REPLACE FUNCTION get_tokens_for_holder_analysis_v3(
    p_batch_size INT DEFAULT 10
) RETURNS TABLE (
    token_id UUID,
    mint_address VARCHAR(44),
    symbol VARCHAR(10),
    bonding_curve_progress DECIMAL(5,2),
    technical_score DECIMAL(5,1),
    holder_score DECIMAL(5,1),
    combined_score DECIMAL(6,1),
    last_analyzed TIMESTAMPTZ,
    priority_score INT,
    analysis_tier VARCHAR(20),
    recommended_frequency INT,
    reason TEXT
) AS $$
BEGIN
    RETURN QUERY
    WITH scored_tokens AS (
        SELECT 
            t.id,
            t.mint_address,
            t.symbol,
            p.bonding_curve_progress,
            ts.total_score as tech_score,
            hs.total_score as hold_score,
            COALESCE(ts.total_score, 0) + COALESCE(hs.total_score, 0) as combined,
            t.last_holder_analysis,
            (calculate_dynamic_frequency(t.id)).*
        FROM tokens t
        JOIN pools p ON p.token_id = t.id
        LEFT JOIN LATERAL (
            SELECT total_score 
            FROM technical_scores 
            WHERE token_id = t.id 
            ORDER BY score_time DESC 
            LIMIT 1
        ) ts ON true
        LEFT JOIN LATERAL (
            SELECT total_score 
            FROM holder_scores_v2 
            WHERE token_id = t.id 
            ORDER BY score_time DESC 
            LIMIT 1
        ) hs ON true
        WHERE 
            t.platform = 'pumpfun'
            AND p.status = 'active'
            AND p.bonding_curve_progress BETWEEN 5 AND 84
            AND (
                t.next_holder_analysis IS NULL 
                OR t.next_holder_analysis <= NOW()
                OR t.analysis_tier IN ('ultra_critical', 'critical')
            )
    ),
    tiered_selection AS (
        -- Ultra critical tokens (always include)
        SELECT * FROM scored_tokens WHERE analysis_tier = 'ultra_critical'
        UNION ALL
        -- Critical tokens (up to 50% of batch)
        (SELECT * FROM scored_tokens 
         WHERE analysis_tier = 'critical' 
         ORDER BY priority_score DESC 
         LIMIT GREATEST(1, p_batch_size / 2))
        UNION ALL
        -- High priority tokens (up to 30% of batch)
        (SELECT * FROM scored_tokens 
         WHERE analysis_tier = 'high_priority'
         AND id NOT IN (SELECT id FROM scored_tokens WHERE analysis_tier IN ('ultra_critical', 'critical'))
         ORDER BY priority_score DESC 
         LIMIT GREATEST(1, p_batch_size * 3 / 10))
        UNION ALL
        -- Fill remaining with other tiers
        (SELECT * FROM scored_tokens 
         WHERE analysis_tier NOT IN ('ultra_critical', 'critical', 'high_priority')
         ORDER BY priority_score DESC 
         LIMIT p_batch_size)
    )
    SELECT DISTINCT ON (id)
        id as token_id,
        mint_address,
        symbol,
        bonding_curve_progress,
        tech_score as technical_score,
        hold_score as holder_score,
        combined as combined_score,
        last_analyzed,
        priority_score,
        analysis_tier,
        frequency_seconds as recommended_frequency,
        reason
    FROM tiered_selection
    ORDER BY id, priority_score DESC
    LIMIT p_batch_size;
END;
$$ LANGUAGE plpgsql;

-- Function to update token after ANY score change
CREATE OR REPLACE FUNCTION update_token_scores_and_frequency(
    p_token_id UUID,
    p_score_type VARCHAR(20),  -- 'technical' or 'holder'
    p_new_score DECIMAL(5,1)
) RETURNS VOID AS $$
DECLARE
    v_frequency_data RECORD;
    v_combined DECIMAL(6,1);
    v_momentum DECIMAL(10,2);
BEGIN
    -- Update the specific score
    IF p_score_type = 'technical' THEN
        UPDATE tokens 
        SET 
            last_technical_score = p_new_score,
            technical_score_time = NOW()
        WHERE id = p_token_id;
    ELSIF p_score_type = 'holder' THEN
        UPDATE tokens 
        SET 
            last_holder_score = p_new_score,
            last_holder_analysis = NOW()
        WHERE id = p_token_id;
    END IF;
    
    -- Get new frequency calculation
    SELECT * INTO v_frequency_data
    FROM calculate_dynamic_frequency(p_token_id);
    
    -- Calculate combined score
    SELECT 
        COALESCE(last_technical_score, 0) + COALESCE(last_holder_score, 0),
        CASE 
            WHEN combined_score > 0 THEN 
                ABS((COALESCE(last_technical_score, 0) + COALESCE(last_holder_score, 0)) - combined_score) / combined_score * 100
            ELSE 0
        END
    INTO v_combined, v_momentum
    FROM tokens
    WHERE id = p_token_id;
    
    -- Update token with new calculations
    UPDATE tokens
    SET 
        combined_score = v_combined,
        score_momentum = v_momentum,
        analysis_tier = v_frequency_data.analysis_tier,
        holder_analysis_frequency = v_frequency_data.frequency_seconds,
        holder_score_priority = v_frequency_data.priority_score,
        next_holder_analysis = NOW() + (v_frequency_data.frequency_seconds || ' seconds')::INTERVAL,
        min_analysis_interval = CASE
            WHEN v_frequency_data.analysis_tier = 'ultra_critical' THEN 30
            WHEN v_frequency_data.analysis_tier = 'critical' THEN 60
            ELSE v_frequency_data.frequency_seconds
        END
    WHERE id = p_token_id;
END;
$$ LANGUAGE plpgsql;

-- Real-time monitoring view
CREATE OR REPLACE VIEW holder_analysis_real_time AS
SELECT 
    t.symbol,
    t.mint_address,
    t.analysis_tier,
    t.combined_score,
    t.last_technical_score as technical_score,
    t.last_holder_score as holder_score,
    t.score_momentum,
    p.bonding_curve_progress,
    t.holder_analysis_frequency as update_frequency_seconds,
    t.last_holder_analysis,
    t.next_holder_analysis,
    CASE 
        WHEN t.next_holder_analysis <= NOW() THEN 'PENDING'
        WHEN t.analysis_tier = 'ultra_critical' THEN 'ULTRA HIGH'
        WHEN t.analysis_tier = 'critical' THEN 'CRITICAL'
        ELSE 'NORMAL'
    END as status,
    EXTRACT(EPOCH FROM (t.next_holder_analysis - NOW()))::INT as seconds_until_next
FROM tokens t
JOIN pools p ON p.token_id = t.id
WHERE 
    t.platform = 'pumpfun'
    AND p.status = 'active'
    AND p.bonding_curve_progress BETWEEN 5 AND 84
ORDER BY 
    t.analysis_tier = 'ultra_critical' DESC,
    t.analysis_tier = 'critical' DESC,
    t.combined_score DESC;

-- Performance tracking for ultra-fast analysis
CREATE TABLE IF NOT EXISTS holder_analysis_performance_v2 (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    
    -- Tier distribution
    ultra_critical_count INT DEFAULT 0,
    critical_count INT DEFAULT 0,
    high_priority_count INT DEFAULT 0,
    elevated_count INT DEFAULT 0,
    standard_count INT DEFAULT 0,
    low_priority_count INT DEFAULT 0,
    minimal_count INT DEFAULT 0,
    
    -- Performance metrics
    avg_frequency_seconds INT,
    min_frequency_seconds INT,
    max_frequency_seconds INT,
    tokens_analyzed_per_minute INT,
    
    -- Score distribution
    avg_combined_score DECIMAL(6,1),
    max_combined_score DECIMAL(6,1),
    tokens_above_500 INT DEFAULT 0,
    tokens_above_400 INT DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Alert function for ultra-critical tokens
CREATE OR REPLACE FUNCTION get_ultra_critical_tokens()
RETURNS TABLE (
    symbol VARCHAR(10),
    mint_address VARCHAR(44),
    combined_score DECIMAL(6,1),
    technical_score DECIMAL(5,1),
    holder_score DECIMAL(5,1),
    bonding_curve_progress DECIMAL(5,2),
    update_frequency INT,
    alert_reason TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        t.symbol,
        t.mint_address,
        t.combined_score,
        t.last_technical_score,
        t.last_holder_score,
        p.bonding_curve_progress,
        t.holder_analysis_frequency,
        CASE
            WHEN t.combined_score >= 550 THEN '🔥 EXCEPTIONAL: Combined score ' || t.combined_score::TEXT
            WHEN t.combined_score >= 500 THEN '⚡ EXCELLENT: Combined score ' || t.combined_score::TEXT
            WHEN t.last_technical_score >= 300 THEN '📈 TECHNICAL BREAKOUT: ' || t.last_technical_score::TEXT
            WHEN p.bonding_curve_progress BETWEEN 75 AND 84 THEN '🎯 NEAR GRADUATION: ' || p.bonding_curve_progress::TEXT || '%'
            WHEN t.score_momentum > 30 THEN '🚀 RAPID MOMENTUM: ' || t.score_momentum::TEXT || '% change'
            ELSE '⭐ HIGH PRIORITY'
        END as alert_reason
    FROM tokens t
    JOIN pools p ON p.token_id = t.id
    WHERE 
        t.analysis_tier IN ('ultra_critical', 'critical')
        AND p.status = 'active'
    ORDER BY t.combined_score DESC
    LIMIT 20;
END;
$$ LANGUAGE plpgsql;