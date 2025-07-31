-- Create a materialized view for token scores
-- This would be populated by your ML scoring engine

CREATE TABLE IF NOT EXISTS token_scores (
    token_address VARCHAR(66) PRIMARY KEY,
    total_score INTEGER NOT NULL DEFAULT 0,
    technical_score INTEGER NOT NULL DEFAULT 0,
    holder_score INTEGER NOT NULL DEFAULT 0,
    social_score INTEGER NOT NULL DEFAULT 0,
    graduation_probability DECIMAL(5,2) DEFAULT 0,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_token_address FOREIGN KEY (token_address) REFERENCES tokens(address)
);

-- Index for fast lookups
CREATE INDEX idx_token_scores_total ON token_scores(total_score DESC);
CREATE INDEX idx_token_scores_updated ON token_scores(last_updated);

-- Function to calculate technical score based on metrics
CREATE OR REPLACE FUNCTION calculate_technical_score(
    p_liquidity_usd NUMERIC,
    p_volume_24h NUMERIC,
    p_price_stability NUMERIC,
    p_bonding_progress NUMERIC
) RETURNS INTEGER AS $$
DECLARE
    liquidity_score INTEGER;
    volume_score INTEGER;
    stability_score INTEGER;
BEGIN
    -- Liquidity scoring (max 111 points)
    liquidity_score := LEAST(111, GREATEST(0, 
        CASE 
            WHEN p_liquidity_usd > 100000 THEN 111
            WHEN p_liquidity_usd > 50000 THEN 90
            WHEN p_liquidity_usd > 10000 THEN 60
            ELSE p_liquidity_usd / 100
        END
    ));
    
    -- Volume scoring (max 111 points)
    volume_score := LEAST(111, GREATEST(0,
        CASE
            WHEN p_volume_24h > 1000000 THEN 111
            WHEN p_volume_24h > 100000 THEN 90
            WHEN p_volume_24h > 10000 THEN 60
            ELSE p_volume_24h / 100
        END
    ));
    
    -- Stability scoring (max 111 points)
    stability_score := LEAST(111, GREATEST(0, 111 * (1 - p_price_stability)));
    
    RETURN liquidity_score + volume_score + stability_score;
END;
$$ LANGUAGE plpgsql;

-- Sample query to populate scores (this would be replaced by your ML engine)
-- INSERT INTO token_scores (token_address, total_score, technical_score, holder_score, social_score)
-- SELECT 
--     t.address,
--     FLOOR(RANDOM() * 999 + 1)::int,
--     FLOOR(RANDOM() * 333 + 1)::int,
--     FLOOR(RANDOM() * 333 + 1)::int,
--     FLOOR(RANDOM() * 333 + 1)::int
-- FROM tokens t
-- WHERE t.created_at > NOW() - INTERVAL '7 days'
-- ON CONFLICT (token_address) DO UPDATE
-- SET 
--     total_score = EXCLUDED.total_score,
--     technical_score = EXCLUDED.technical_score,
--     holder_score = EXCLUDED.holder_score,
--     social_score = EXCLUDED.social_score,
--     last_updated = NOW();