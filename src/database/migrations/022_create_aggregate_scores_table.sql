-- Migration: 022_create_aggregate_scores_table
-- Description: Creates aggregate scores table to combine technical, holder, and social scores
-- This provides a single source of truth for the 999-point total scoring system

-- Drop existing objects if they exist
DROP TABLE IF EXISTS aggregate_scores CASCADE;
DROP FUNCTION IF EXISTS update_aggregate_scores CASCADE;
DROP FUNCTION IF EXISTS calculate_total_score CASCADE;

-- Create the aggregate scores table
CREATE TABLE aggregate_scores (
    id UUID DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES tokens(id) NOT NULL,
    score_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Component scores (each max 333 points)
    technical_score DECIMAL(5,1) NOT NULL DEFAULT 0 CHECK (technical_score BETWEEN 0 AND 333),
    holder_score DECIMAL(5,1) NOT NULL DEFAULT 0 CHECK (holder_score BETWEEN 0 AND 333),
    social_score DECIMAL(5,1) NOT NULL DEFAULT 0 CHECK (social_score BETWEEN 0 AND 333),
    
    -- Total score (max 999 points)
    total_score DECIMAL(6,1) GENERATED ALWAYS AS (technical_score + holder_score + social_score) STORED,
    
    -- Score percentages for easy comparison
    technical_percentage DECIMAL(5,2) GENERATED ALWAYS AS (technical_score / 333 * 100) STORED,
    holder_percentage DECIMAL(5,2) GENERATED ALWAYS AS (holder_score / 333 * 100) STORED,
    social_percentage DECIMAL(5,2) GENERATED ALWAYS AS (social_score / 333 * 100) STORED,
    total_percentage DECIMAL(5,2) GENERATED ALWAYS AS ((technical_score + holder_score + social_score) / 999 * 100) STORED,
    
    -- Metadata from component scores
    bonding_curve_progress DECIMAL(5,2),
    market_cap_usd DECIMAL(20,2),
    unique_holders INT,
    gini_coefficient DECIMAL(5,4),
    bot_ratio DECIMAL(5,4),
    
    -- Scoring metadata
    is_stale BOOLEAN DEFAULT FALSE,
    last_technical_update TIMESTAMPTZ,
    last_holder_update TIMESTAMPTZ,
    last_social_update TIMESTAMPTZ,
    
    -- Version tracking
    scoring_version VARCHAR(10) DEFAULT 'v2.0',
    
    PRIMARY KEY (id, score_time)
);

-- Create indexes for efficient querying
CREATE INDEX idx_aggregate_scores_token_time ON aggregate_scores(token_id, score_time DESC);
CREATE INDEX idx_aggregate_scores_total ON aggregate_scores(total_score DESC) WHERE NOT is_stale;
CREATE INDEX idx_aggregate_scores_technical ON aggregate_scores(technical_score DESC) WHERE NOT is_stale;
CREATE INDEX idx_aggregate_scores_holder ON aggregate_scores(holder_score DESC) WHERE NOT is_stale;
CREATE INDEX idx_aggregate_scores_percentage ON aggregate_scores(total_percentage DESC) WHERE NOT is_stale;

-- Convert to TimescaleDB hypertable if available
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        -- Check if already a hypertable
        IF NOT EXISTS (
            SELECT 1 FROM timescaledb_information.hypertables 
            WHERE hypertable_name = 'aggregate_scores'
        ) THEN
            PERFORM create_hypertable('aggregate_scores', 'score_time', if_not_exists => true);
        END IF;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'TimescaleDB hypertable creation skipped: %', SQLERRM;
END $$;

-- Function to update aggregate scores
CREATE OR REPLACE FUNCTION update_aggregate_scores(
    p_token_id UUID
) RETURNS aggregate_scores AS $$
DECLARE
    v_technical_score DECIMAL(5,1);
    v_holder_score DECIMAL(5,1);
    v_social_score DECIMAL(5,1);
    v_bonding_progress DECIMAL(5,2);
    v_market_cap DECIMAL(20,2);
    v_unique_holders INT;
    v_gini DECIMAL(5,4);
    v_bot_ratio DECIMAL(5,4);
    v_pool_id UUID;
    v_result aggregate_scores;
BEGIN
    -- Get pool ID for technical score calculation
    SELECT id, bonding_curve_progress, latest_price_usd * 1000000000
    INTO v_pool_id, v_bonding_progress, v_market_cap
    FROM pools
    WHERE token_id = p_token_id
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Get latest technical score
    SELECT total_score INTO v_technical_score
    FROM calculate_technical_score(p_token_id, v_pool_id);
    
    IF v_technical_score IS NULL THEN
        v_technical_score := 0;
    END IF;
    
    -- Get latest holder score
    SELECT 
        total_score,
        unique_holders,
        gini_coefficient,
        bot_ratio
    INTO 
        v_holder_score,
        v_unique_holders,
        v_gini,
        v_bot_ratio
    FROM holder_scores_v2
    WHERE token_id = p_token_id
    ORDER BY score_time DESC
    LIMIT 1;
    
    IF v_holder_score IS NULL THEN
        v_holder_score := 0;
    END IF;
    
    -- Social score not implemented yet
    v_social_score := 0;
    
    -- Insert or update aggregate score
    INSERT INTO aggregate_scores (
        token_id,
        technical_score,
        holder_score,
        social_score,
        bonding_curve_progress,
        market_cap_usd,
        unique_holders,
        gini_coefficient,
        bot_ratio,
        last_technical_update,
        last_holder_update,
        last_social_update
    ) VALUES (
        p_token_id,
        v_technical_score,
        v_holder_score,
        v_social_score,
        v_bonding_progress,
        v_market_cap,
        v_unique_holders,
        v_gini,
        v_bot_ratio,
        CASE WHEN v_technical_score > 0 THEN NOW() ELSE NULL END,
        CASE WHEN v_holder_score > 0 THEN NOW() ELSE NULL END,
        NULL -- Social not implemented
    )
    RETURNING * INTO v_result;
    
    RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- Function to get latest aggregate score for a token
CREATE OR REPLACE FUNCTION get_latest_aggregate_score(
    p_token_id UUID
) RETURNS TABLE (
    token_id UUID,
    technical_score DECIMAL(5,1),
    holder_score DECIMAL(5,1),
    social_score DECIMAL(5,1),
    total_score DECIMAL(6,1),
    total_percentage DECIMAL(5,2),
    score_time TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.token_id,
        a.technical_score,
        a.holder_score,
        a.social_score,
        a.total_score,
        a.total_percentage,
        a.score_time
    FROM aggregate_scores a
    WHERE a.token_id = p_token_id
        AND NOT a.is_stale
    ORDER BY a.score_time DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update aggregate scores when technical scores change
CREATE OR REPLACE FUNCTION trigger_update_aggregate_on_technical() RETURNS TRIGGER AS $$
BEGIN
    -- Update aggregate score for this token
    PERFORM update_aggregate_scores(NEW.token_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update aggregate scores when holder scores change
CREATE OR REPLACE FUNCTION trigger_update_aggregate_on_holder() RETURNS TRIGGER AS $$
BEGIN
    -- Update aggregate score for this token
    PERFORM update_aggregate_scores(NEW.token_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers
CREATE TRIGGER update_aggregate_on_technical_score
    AFTER INSERT OR UPDATE ON technical_scores
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_aggregate_on_technical();

CREATE TRIGGER update_aggregate_on_holder_score
    AFTER INSERT OR UPDATE ON holder_scores_v2
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_aggregate_on_holder();

-- Create a view for easy access to latest scores
CREATE OR REPLACE VIEW latest_aggregate_scores AS
SELECT DISTINCT ON (token_id)
    token_id,
    technical_score,
    holder_score,
    social_score,
    total_score,
    technical_percentage,
    holder_percentage,
    social_percentage,
    total_percentage,
    bonding_curve_progress,
    market_cap_usd,
    unique_holders,
    gini_coefficient,
    bot_ratio,
    score_time,
    last_technical_update,
    last_holder_update,
    last_social_update,
    is_stale
FROM aggregate_scores
WHERE NOT is_stale
ORDER BY token_id, score_time DESC;

-- Function to backfill aggregate scores for existing data
CREATE OR REPLACE FUNCTION backfill_aggregate_scores() RETURNS void AS $$
DECLARE
    v_token RECORD;
    v_count INT := 0;
BEGIN
    -- Get all tokens with either technical or holder scores
    FOR v_token IN 
        SELECT DISTINCT t.id as token_id
        FROM tokens t
        WHERE EXISTS (
            SELECT 1 FROM technical_scores ts WHERE ts.token_id = t.id
        ) OR EXISTS (
            SELECT 1 FROM holder_scores_v2 hs WHERE hs.token_id = t.id
        )
    LOOP
        PERFORM update_aggregate_scores(v_token.token_id);
        v_count := v_count + 1;
    END LOOP;
    
    RAISE NOTICE 'Backfilled aggregate scores for % tokens', v_count;
END;
$$ LANGUAGE plpgsql;

-- Add comments for documentation
COMMENT ON TABLE aggregate_scores IS 'Unified scoring table combining technical (333), holder (333), and social (333) scores for total 999-point system';
COMMENT ON COLUMN aggregate_scores.total_score IS 'Total score (0-999) automatically calculated as sum of component scores';
COMMENT ON COLUMN aggregate_scores.technical_score IS 'Technical analysis score (0-333) from market metrics';
COMMENT ON COLUMN aggregate_scores.holder_score IS 'Holder analysis score (0-333) from wallet distribution and quality';
COMMENT ON COLUMN aggregate_scores.social_score IS 'Social sentiment score (0-333) - not yet implemented';
COMMENT ON FUNCTION update_aggregate_scores IS 'Updates or creates aggregate score entry for a token by combining latest component scores';
COMMENT ON FUNCTION get_latest_aggregate_score IS 'Returns the most recent aggregate score for a token';
COMMENT ON VIEW latest_aggregate_scores IS 'Convenient view showing latest aggregate scores for all tokens';

-- Grant permissions
GRANT SELECT ON aggregate_scores TO PUBLIC;
GRANT SELECT ON latest_aggregate_scores TO PUBLIC;
GRANT ALL ON aggregate_scores TO postgres;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Aggregate scores table created successfully!';
    RAISE NOTICE 'Run SELECT backfill_aggregate_scores() to populate historical data';
    RAISE NOTICE 'View latest scores with: SELECT * FROM latest_aggregate_scores';
END $$;