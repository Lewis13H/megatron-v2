-- Delete all tokens not created today and their related data
-- Run this to clean up test data from previous days

BEGIN;

-- Delete technical scores
DELETE FROM technical_scores 
WHERE token_id IN (
    SELECT id FROM tokens WHERE DATE(created_at) < CURRENT_DATE
);

-- Delete holder scores
DELETE FROM holder_scores 
WHERE token_id IN (
    SELECT id FROM tokens WHERE DATE(created_at) < CURRENT_DATE
);

-- Delete holder snapshots
DELETE FROM holder_snapshots 
WHERE token_id IN (
    SELECT id FROM tokens WHERE DATE(created_at) < CURRENT_DATE
);

-- Delete token holders
DELETE FROM token_holders 
WHERE token_id IN (
    SELECT id FROM tokens WHERE DATE(created_at) < CURRENT_DATE
);

-- Delete transactions
DELETE FROM transactions 
WHERE token_id IN (
    SELECT id FROM tokens WHERE DATE(created_at) < CURRENT_DATE
);

-- Delete pools
DELETE FROM pools 
WHERE token_id IN (
    SELECT id FROM tokens WHERE DATE(created_at) < CURRENT_DATE
);

-- Finally delete the tokens
DELETE FROM tokens 
WHERE DATE(created_at) < CURRENT_DATE;

-- Show what remains
SELECT 
    DATE(created_at) as date, 
    COUNT(*) as remaining_tokens 
FROM tokens 
GROUP BY DATE(created_at) 
ORDER BY date DESC;

COMMIT;