-- Create latest_holder_scores view to get the most recent holder score per token
CREATE OR REPLACE VIEW latest_holder_scores AS
SELECT DISTINCT ON (token_id)
    id,
    token_id,
    total_score,
    distribution_score,
    quality_score,
    activity_score,
    gini_coefficient,
    top_10_concentration,
    unique_holders,
    avg_wallet_age_days,
    bot_ratio,
    organic_growth_score,
    score_time,
    bonding_curve_progress,
    score_details,
    red_flags,
    yellow_flags,
    positive_signals
FROM holder_scores
ORDER BY token_id, score_time DESC;