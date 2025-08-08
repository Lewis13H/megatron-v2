-- Migration: 025_instant_holder_analysis_trigger
-- Description: Trigger instant holder analysis for high technical scores
-- Any token reaching 180+ technical score gets immediate holder analysis

-- Add columns for instant analysis tracking
ALTER TABLE tokens
ADD COLUMN IF NOT EXISTS instant_analysis_required BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS instant_analysis_reason TEXT,
ADD COLUMN IF NOT EXISTS instant_analysis_triggered_at TIMESTAMPTZ;

-- Create index for instant analysis queue
CREATE INDEX IF NOT EXISTS idx_tokens_instant_analysis 
ON tokens(instant_analysis_required, last_technical_score DESC)
WHERE instant_analysis_required = true;

-- Function to check and trigger instant holder analysis
CREATE OR REPLACE FUNCTION trigger_instant_holder_analysis()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if technical score crosses threshold
    IF NEW.last_technical_score >= 180 AND 
       (OLD.last_technical_score IS NULL OR OLD.last_technical_score < 180) THEN
        
        -- Check if holder score is missing or old
        IF NEW.last_holder_score IS NULL OR 
           NEW.last_holder_score = 0 OR
           NEW.last_holder_analysis IS NULL OR
           NEW.last_holder_analysis < NOW() - INTERVAL '30 minutes' THEN
            
            -- Mark for instant analysis
            NEW.instant_analysis_required := TRUE;
            NEW.instant_analysis_reason := 'Technical score ' || NEW.last_technical_score::TEXT || ' - requires immediate holder analysis';
            NEW.instant_analysis_triggered_at := NOW();
            NEW.next_holder_analysis := NOW(); -- Immediate
            NEW.analysis_tier := 'critical';
            NEW.holder_analysis_frequency := 60; -- 1 minute frequency
            
            -- Log the trigger
            RAISE NOTICE 'INSTANT ANALYSIS: Token % reached technical score %, triggering immediate holder analysis', 
                NEW.symbol, NEW.last_technical_score;
        END IF;
    END IF;
    
    -- Also trigger for extremely high technical scores (250+)
    IF NEW.last_technical_score >= 250 AND 
       (NEW.last_holder_analysis IS NULL OR NEW.last_holder_analysis < NOW() - INTERVAL '10 minutes') THEN
        NEW.instant_analysis_required := TRUE;
        NEW.instant_analysis_reason := 'ULTRA HIGH technical score ' || NEW.last_technical_score::TEXT;
        NEW.instant_analysis_triggered_at := NOW();
        NEW.next_holder_analysis := NOW();
        NEW.analysis_tier := 'ultra_critical';
        NEW.holder_analysis_frequency := 30; -- 30 seconds
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on tokens table
DROP TRIGGER IF EXISTS instant_holder_analysis_trigger ON tokens;
CREATE TRIGGER instant_holder_analysis_trigger
BEFORE UPDATE OF last_technical_score ON tokens
FOR EACH ROW
EXECUTE FUNCTION trigger_instant_holder_analysis();

-- Function to get tokens requiring instant analysis
CREATE OR REPLACE FUNCTION get_instant_analysis_tokens()
RETURNS TABLE (
    token_id UUID,
    mint_address VARCHAR(44),
    symbol VARCHAR(10),
    technical_score DECIMAL(5,1),
    holder_score DECIMAL(5,1),
    bonding_curve_progress DECIMAL(5,2),
    reason TEXT,
    triggered_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        t.id,
        t.mint_address,
        t.symbol,
        t.last_technical_score,
        t.last_holder_score,
        p.bonding_curve_progress,
        t.instant_analysis_reason,
        t.instant_analysis_triggered_at
    FROM tokens t
    JOIN pools p ON p.token_id = t.id
    WHERE 
        t.instant_analysis_required = true
        AND p.status = 'active'
    ORDER BY 
        t.last_technical_score DESC,
        t.instant_analysis_triggered_at ASC
    LIMIT 20;
END;
$$ LANGUAGE plpgsql;

-- Function to clear instant analysis flag after completion
CREATE OR REPLACE FUNCTION clear_instant_analysis_flag(
    p_token_id UUID,
    p_holder_score DECIMAL(5,1)
) RETURNS VOID AS $$
BEGIN
    UPDATE tokens
    SET 
        instant_analysis_required = FALSE,
        instant_analysis_reason = NULL,
        last_holder_score = p_holder_score,
        last_holder_analysis = NOW()
    WHERE id = p_token_id;
END;
$$ LANGUAGE plpgsql;

-- Enhanced update function that handles both scores
CREATE OR REPLACE FUNCTION update_token_scores_with_instant_check(
    p_token_id UUID,
    p_score_type VARCHAR(20),  -- 'technical' or 'holder'
    p_new_score DECIMAL(5,1)
) RETURNS TABLE (
    needs_instant_analysis BOOLEAN,
    analysis_tier VARCHAR(20),
    reason TEXT
) AS $$
DECLARE
    v_token RECORD;
    v_needs_instant BOOLEAN := FALSE;
    v_tier VARCHAR(20) := 'standard';
    v_reason TEXT := '';
BEGIN
    -- Get current token state
    SELECT * INTO v_token
    FROM tokens
    WHERE id = p_token_id;
    
    -- Update the specific score
    IF p_score_type = 'technical' THEN
        UPDATE tokens 
        SET 
            last_technical_score = p_new_score,
            technical_score_time = NOW()
        WHERE id = p_token_id;
        
        -- Check if instant holder analysis needed
        IF p_new_score >= 180 THEN
            IF v_token.last_holder_score IS NULL OR 
               v_token.last_holder_score = 0 OR
               (p_new_score >= 250 AND v_token.last_holder_analysis < NOW() - INTERVAL '10 minutes') THEN
                
                v_needs_instant := TRUE;
                v_tier := CASE 
                    WHEN p_new_score >= 250 THEN 'ultra_critical'
                    WHEN p_new_score >= 200 THEN 'critical'
                    ELSE 'high_priority'
                END;
                v_reason := 'Technical score ' || p_new_score::TEXT || ' requires immediate holder analysis';
                
                -- Mark token for instant analysis
                UPDATE tokens
                SET 
                    instant_analysis_required = TRUE,
                    instant_analysis_reason = v_reason,
                    instant_analysis_triggered_at = NOW(),
                    next_holder_analysis = NOW(),
                    analysis_tier = v_tier
                WHERE id = p_token_id;
            END IF;
        END IF;
        
    ELSIF p_score_type = 'holder' THEN
        UPDATE tokens 
        SET 
            last_holder_score = p_new_score,
            last_holder_analysis = NOW(),
            instant_analysis_required = FALSE,
            instant_analysis_reason = NULL
        WHERE id = p_token_id;
    END IF;
    
    -- Update combined score and frequency
    PERFORM update_token_scores_and_frequency(p_token_id, p_score_type, p_new_score);
    
    RETURN QUERY SELECT v_needs_instant, v_tier, v_reason;
END;
$$ LANGUAGE plpgsql;

-- View to monitor high technical score tokens without holder scores
CREATE OR REPLACE VIEW technical_holder_gap AS
SELECT 
    t.symbol,
    t.mint_address,
    t.last_technical_score as technical_score,
    t.last_holder_score as holder_score,
    p.bonding_curve_progress,
    t.last_holder_analysis,
    CASE 
        WHEN t.last_holder_score IS NULL THEN 'NEVER ANALYZED'
        WHEN t.last_holder_score = 0 THEN 'ZERO SCORE'
        WHEN t.last_holder_analysis < NOW() - INTERVAL '1 hour' THEN 'STALE (>1hr)'
        WHEN t.last_holder_analysis < NOW() - INTERVAL '30 minutes' THEN 'AGING (>30min)'
        ELSE 'RECENT'
    END as holder_status,
    t.instant_analysis_required,
    t.analysis_tier
FROM tokens t
JOIN pools p ON p.token_id = t.id
WHERE 
    t.last_technical_score >= 180
    AND (
        t.last_holder_score IS NULL OR 
        t.last_holder_score = 0 OR
        t.last_holder_analysis IS NULL OR
        t.last_holder_analysis < NOW() - INTERVAL '30 minutes'
    )
    AND p.status = 'active'
ORDER BY 
    t.last_technical_score DESC,
    t.last_holder_analysis ASC NULLS FIRST;

-- Retroactively mark existing high-score tokens for instant analysis
UPDATE tokens t
SET 
    instant_analysis_required = TRUE,
    instant_analysis_reason = 'Retroactive: Technical score ' || last_technical_score::TEXT || ' without recent holder score',
    instant_analysis_triggered_at = NOW(),
    next_holder_analysis = NOW(),
    analysis_tier = CASE
        WHEN last_technical_score >= 250 THEN 'ultra_critical'
        WHEN last_technical_score >= 200 THEN 'critical'
        ELSE 'high_priority'
    END
FROM pools p
WHERE 
    p.token_id = t.id
    AND t.last_technical_score >= 180
    AND (
        t.last_holder_score IS NULL OR 
        t.last_holder_score = 0 OR
        t.last_holder_analysis IS NULL OR
        t.last_holder_analysis < NOW() - INTERVAL '30 minutes'
    )
    AND p.status = 'active';

-- Stats function for monitoring
CREATE OR REPLACE FUNCTION get_instant_analysis_stats()
RETURNS TABLE (
    total_high_technical INT,
    missing_holder_scores INT,
    stale_holder_scores INT,
    instant_queue_size INT,
    avg_technical_score DECIMAL(5,1),
    max_technical_score DECIMAL(5,1)
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*)::INT as total_high_technical,
        COUNT(CASE WHEN last_holder_score IS NULL OR last_holder_score = 0 THEN 1 END)::INT as missing_holder_scores,
        COUNT(CASE WHEN last_holder_analysis < NOW() - INTERVAL '30 minutes' THEN 1 END)::INT as stale_holder_scores,
        COUNT(CASE WHEN instant_analysis_required = true THEN 1 END)::INT as instant_queue_size,
        AVG(last_technical_score)::DECIMAL(5,1) as avg_technical_score,
        MAX(last_technical_score)::DECIMAL(5,1) as max_technical_score
    FROM tokens t
    JOIN pools p ON p.token_id = t.id
    WHERE 
        t.last_technical_score >= 180
        AND p.status = 'active';
END;
$$ LANGUAGE plpgsql;