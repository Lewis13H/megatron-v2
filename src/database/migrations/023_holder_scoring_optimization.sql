-- Migration: 023_holder_scoring_optimization
-- Description: Optimize holder scoring with priority-based recalculation
-- High-scoring tokens get analyzed more frequently

-- Add priority and frequency tracking columns
ALTER TABLE tokens 
ADD COLUMN IF NOT EXISTS holder_score_priority INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_holder_score DECIMAL(5,1) DEFAULT 0,
ADD COLUMN IF NOT EXISTS holder_score_velocity DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS holder_analysis_frequency INT DEFAULT 3600,
ADD COLUMN IF NOT EXISTS next_holder_analysis TIMESTAMPTZ DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS last_holder_analysis TIMESTAMPTZ;

-- Create index for efficient priority-based queries
CREATE INDEX IF NOT EXISTS idx_tokens_holder_priority ON tokens(holder_score_priority DESC, next_holder_analysis ASC)
WHERE platform = 'pumpfun';

-- Priority scoring function
CREATE OR REPLACE FUNCTION calculate_holder_priority(
    p_token_id UUID
) RETURNS INT AS $$
DECLARE
    v_priority INT := 0;
    v_token RECORD;
    v_latest_score RECORD;
BEGIN
    -- Get token data
    SELECT 
        t.*,
        p.bonding_curve_progress,
        p.latest_price,
        p.price_change_24h_percent
    INTO v_token
    FROM tokens t
    LEFT JOIN pools p ON p.token_id = t.id
    WHERE t.id = p_token_id;
    
    -- Get latest holder score
    SELECT * INTO v_latest_score
    FROM holder_scores_v2
    WHERE token_id = p_token_id
    ORDER BY score_time DESC
    LIMIT 1;
    
    -- Base priority on score (0-100 points)
    IF v_latest_score.total_score IS NOT NULL THEN
        -- Higher scores get higher priority
        v_priority := GREATEST(0, LEAST(100, 
            CASE 
                WHEN v_latest_score.total_score >= 250 THEN 100  -- Excellent
                WHEN v_latest_score.total_score >= 200 THEN 80   -- Very Good
                WHEN v_latest_score.total_score >= 150 THEN 60   -- Good
                WHEN v_latest_score.total_score >= 100 THEN 40   -- Average
                ELSE 20                                           -- Poor
            END
        ));
    END IF;
    
    -- Bonding curve progress bonus (0-30 points)
    -- Sweet spot: 15-40% progress
    IF v_token.bonding_curve_progress BETWEEN 15 AND 40 THEN
        v_priority := v_priority + 30;
    ELSIF v_token.bonding_curve_progress BETWEEN 10 AND 50 THEN
        v_priority := v_priority + 20;
    ELSIF v_token.bonding_curve_progress BETWEEN 5 AND 60 THEN
        v_priority := v_priority + 10;
    END IF;
    
    -- Volatility bonus (0-20 points)
    -- High price changes need more frequent updates
    IF ABS(v_token.price_change_24h_percent) > 50 THEN
        v_priority := v_priority + 20;
    ELSIF ABS(v_token.price_change_24h_percent) > 25 THEN
        v_priority := v_priority + 10;
    END IF;
    
    -- Score velocity bonus (0-20 points)
    -- Rapidly changing scores need attention
    IF v_token.holder_score_velocity > 20 THEN
        v_priority := v_priority + 20;
    ELSIF v_token.holder_score_velocity > 10 THEN
        v_priority := v_priority + 10;
    END IF;
    
    -- Recency penalty (-30 to 0 points)
    -- Recently analyzed tokens get lower priority
    IF v_token.last_holder_analysis IS NOT NULL THEN
        IF v_token.last_holder_analysis > NOW() - INTERVAL '5 minutes' THEN
            v_priority := v_priority - 30;
        ELSIF v_token.last_holder_analysis > NOW() - INTERVAL '15 minutes' THEN
            v_priority := v_priority - 20;
        ELSIF v_token.last_holder_analysis > NOW() - INTERVAL '30 minutes' THEN
            v_priority := v_priority - 10;
        END IF;
    END IF;
    
    RETURN GREATEST(0, v_priority);
END;
$$ LANGUAGE plpgsql;

-- Enhanced token selection function with priority and tiers
CREATE OR REPLACE FUNCTION get_tokens_for_holder_analysis_v2(
    p_batch_size INT DEFAULT 10,
    p_tier_distribution JSONB DEFAULT '{"high": 0.5, "medium": 0.3, "low": 0.2}'::jsonb
) RETURNS TABLE (
    token_id UUID,
    mint_address VARCHAR(44),
    symbol VARCHAR(10),
    bonding_curve_progress DECIMAL(5,2),
    last_analyzed TIMESTAMPTZ,
    priority_score INT,
    analysis_tier TEXT,
    recommended_frequency INT
) AS $$
DECLARE
    v_high_priority_count INT;
    v_medium_priority_count INT;
    v_low_priority_count INT;
BEGIN
    -- Calculate tier sizes
    v_high_priority_count := FLOOR(p_batch_size * (p_tier_distribution->>'high')::DECIMAL);
    v_medium_priority_count := FLOOR(p_batch_size * (p_tier_distribution->>'medium')::DECIMAL);
    v_low_priority_count := p_batch_size - v_high_priority_count - v_medium_priority_count;
    
    RETURN QUERY
    WITH prioritized_tokens AS (
        SELECT 
            t.id,
            t.mint_address,
            t.symbol,
            p.bonding_curve_progress,
            t.last_holder_analysis,
            calculate_holder_priority(t.id) as priority,
            CASE
                WHEN calculate_holder_priority(t.id) >= 80 THEN 'high'
                WHEN calculate_holder_priority(t.id) >= 50 THEN 'medium'
                ELSE 'low'
            END as tier,
            CASE
                WHEN calculate_holder_priority(t.id) >= 80 THEN 300    -- 5 minutes
                WHEN calculate_holder_priority(t.id) >= 50 THEN 900    -- 15 minutes
                ELSE 1800                                               -- 30 minutes
            END as frequency
        FROM tokens t
        JOIN pools p ON p.token_id = t.id
        WHERE 
            t.platform = 'pumpfun'
            AND p.bonding_curve_progress BETWEEN 5 AND 80
            AND p.status = 'active'
            AND (t.next_holder_analysis IS NULL OR t.next_holder_analysis <= NOW())
    ),
    high_priority AS (
        SELECT * FROM prioritized_tokens 
        WHERE tier = 'high'
        ORDER BY priority DESC, last_analyzed ASC NULLS FIRST
        LIMIT v_high_priority_count
    ),
    medium_priority AS (
        SELECT * FROM prioritized_tokens 
        WHERE tier = 'medium'
            AND id NOT IN (SELECT id FROM high_priority)
        ORDER BY priority DESC, last_analyzed ASC NULLS FIRST
        LIMIT v_medium_priority_count
    ),
    low_priority AS (
        SELECT * FROM prioritized_tokens 
        WHERE tier = 'low'
            AND id NOT IN (SELECT id FROM high_priority)
            AND id NOT IN (SELECT id FROM medium_priority)
        ORDER BY priority DESC, last_analyzed ASC NULLS FIRST
        LIMIT v_low_priority_count
    )
    SELECT 
        id as token_id,
        mint_address,
        symbol,
        bonding_curve_progress,
        last_analyzed,
        priority as priority_score,
        tier as analysis_tier,
        frequency as recommended_frequency
    FROM (
        SELECT * FROM high_priority
        UNION ALL
        SELECT * FROM medium_priority
        UNION ALL
        SELECT * FROM low_priority
    ) combined
    ORDER BY priority DESC;
END;
$$ LANGUAGE plpgsql;

-- Function to update token after analysis
CREATE OR REPLACE FUNCTION update_token_after_holder_analysis(
    p_token_id UUID,
    p_new_score DECIMAL(5,1)
) RETURNS VOID AS $$
DECLARE
    v_old_score DECIMAL(5,1);
    v_velocity DECIMAL(10,2);
    v_priority INT;
    v_frequency INT;
BEGIN
    -- Get previous score
    SELECT last_holder_score INTO v_old_score
    FROM tokens
    WHERE id = p_token_id;
    
    -- Calculate velocity (rate of change)
    IF v_old_score IS NOT NULL AND v_old_score > 0 THEN
        v_velocity := ABS(p_new_score - v_old_score) / v_old_score * 100;
    ELSE
        v_velocity := 0;
    END IF;
    
    -- Calculate new priority
    v_priority := calculate_holder_priority(p_token_id);
    
    -- Determine analysis frequency based on score and velocity
    v_frequency := CASE
        WHEN p_new_score >= 250 OR v_velocity > 30 THEN 300     -- 5 minutes for excellent/volatile
        WHEN p_new_score >= 200 OR v_velocity > 20 THEN 600     -- 10 minutes for very good
        WHEN p_new_score >= 150 OR v_velocity > 10 THEN 900     -- 15 minutes for good
        WHEN p_new_score >= 100 THEN 1800                       -- 30 minutes for average
        ELSE 3600                                                -- 1 hour for poor
    END;
    
    -- Update token
    UPDATE tokens
    SET 
        last_holder_analysis = NOW(),
        last_holder_score = p_new_score,
        holder_score_velocity = v_velocity,
        holder_score_priority = v_priority,
        holder_analysis_frequency = v_frequency,
        next_holder_analysis = NOW() + (v_frequency || ' seconds')::INTERVAL
    WHERE id = p_token_id;
END;
$$ LANGUAGE plpgsql;

-- Create tracking table for performance metrics
CREATE TABLE IF NOT EXISTS holder_analysis_performance (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    analysis_date DATE DEFAULT CURRENT_DATE,
    hour INT DEFAULT EXTRACT(HOUR FROM NOW()),
    
    -- Performance metrics
    tokens_analyzed INT DEFAULT 0,
    avg_processing_time_ms INT,
    cache_hit_rate DECIMAL(5,4),
    api_credits_used INT,
    
    -- Score distribution
    excellent_scores INT DEFAULT 0,  -- >= 250
    very_good_scores INT DEFAULT 0,  -- >= 200
    good_scores INT DEFAULT 0,       -- >= 150
    average_scores INT DEFAULT 0,    -- >= 100
    poor_scores INT DEFAULT 0,       -- < 100
    
    -- Tier distribution
    high_priority_analyzed INT DEFAULT 0,
    medium_priority_analyzed INT DEFAULT 0,
    low_priority_analyzed INT DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(analysis_date, hour)
);

-- View for monitoring system performance
CREATE OR REPLACE VIEW holder_analysis_stats AS
SELECT 
    DATE_TRUNC('hour', NOW()) as current_hour,
    COUNT(DISTINCT t.id) as total_active_tokens,
    COUNT(DISTINCT CASE WHEN t.holder_score_priority >= 80 THEN t.id END) as high_priority_tokens,
    COUNT(DISTINCT CASE WHEN t.holder_score_priority BETWEEN 50 AND 79 THEN t.id END) as medium_priority_tokens,
    COUNT(DISTINCT CASE WHEN t.holder_score_priority < 50 THEN t.id END) as low_priority_tokens,
    AVG(t.last_holder_score) as avg_holder_score,
    MAX(t.last_holder_score) as max_holder_score,
    MIN(t.last_holder_score) as min_holder_score,
    COUNT(DISTINCT CASE WHEN t.last_holder_analysis > NOW() - INTERVAL '1 hour' THEN t.id END) as analyzed_last_hour,
    COUNT(DISTINCT CASE WHEN t.next_holder_analysis <= NOW() THEN t.id END) as pending_analysis
FROM tokens t
JOIN pools p ON p.token_id = t.id
WHERE 
    t.platform = 'pumpfun'
    AND p.bonding_curve_progress BETWEEN 5 AND 80
    AND p.status = 'active';

-- Function to get analysis recommendations
CREATE OR REPLACE FUNCTION get_holder_analysis_recommendations()
RETURNS TABLE (
    recommendation TEXT,
    priority TEXT,
    details JSONB
) AS $$
BEGIN
    -- Check if too many tokens are pending
    IF (SELECT COUNT(*) FROM tokens WHERE next_holder_analysis <= NOW()) > 100 THEN
        RETURN QUERY
        SELECT 
            'Increase batch size or analysis frequency'::TEXT,
            'HIGH'::TEXT,
            jsonb_build_object(
                'pending_tokens', (SELECT COUNT(*) FROM tokens WHERE next_holder_analysis <= NOW()),
                'suggested_batch_size', 20
            );
    END IF;
    
    -- Check cache efficiency
    IF EXISTS (
        SELECT 1 FROM holder_analysis_performance 
        WHERE analysis_date = CURRENT_DATE 
        AND cache_hit_rate < 0.3
    ) THEN
        RETURN QUERY
        SELECT 
            'Low cache hit rate detected'::TEXT,
            'MEDIUM'::TEXT,
            jsonb_build_object(
                'current_hit_rate', (
                    SELECT AVG(cache_hit_rate) 
                    FROM holder_analysis_performance 
                    WHERE analysis_date = CURRENT_DATE
                ),
                'suggestion', 'Increase cache TTL or implement tiered caching'
            );
    END IF;
    
    -- Check API credit usage
    IF EXISTS (
        SELECT 1 FROM helius_api_usage 
        WHERE date = CURRENT_DATE 
        GROUP BY date
        HAVING SUM(credits_used) > 300000  -- Daily limit check
    ) THEN
        RETURN QUERY
        SELECT 
            'High API credit usage'::TEXT,
            'HIGH'::TEXT,
            jsonb_build_object(
                'credits_today', (
                    SELECT SUM(credits_used) 
                    FROM helius_api_usage 
                    WHERE date = CURRENT_DATE
                ),
                'suggestion', 'Reduce analysis frequency or increase cache usage'
            );
    END IF;
    
    RETURN;
END;
$$ LANGUAGE plpgsql;