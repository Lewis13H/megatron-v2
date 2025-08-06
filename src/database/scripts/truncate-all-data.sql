-- Truncate all tables to clear test data
-- This will remove ALL data from the database

-- Disable foreign key checks temporarily
BEGIN;

-- Truncate all tables with CASCADE to handle foreign key dependencies
TRUNCATE TABLE transactions CASCADE;
TRUNCATE TABLE price_candles_1m CASCADE;
TRUNCATE TABLE technical_scores CASCADE;
TRUNCATE TABLE holder_scores CASCADE;
TRUNCATE TABLE holder_snapshots CASCADE;
TRUNCATE TABLE token_holders CASCADE;
TRUNCATE TABLE wallet_analysis_cache CASCADE;
TRUNCATE TABLE pools CASCADE;
TRUNCATE TABLE tokens CASCADE;
TRUNCATE TABLE sol_usd_prices CASCADE;

-- Reset sequences if needed
-- ALTER SEQUENCE tokens_id_seq RESTART WITH 1;
-- ALTER SEQUENCE pools_id_seq RESTART WITH 1;

COMMIT;

-- Verify all tables are empty
SELECT 'tokens' as table_name, COUNT(*) as row_count FROM tokens
UNION ALL
SELECT 'pools', COUNT(*) FROM pools
UNION ALL
SELECT 'transactions', COUNT(*) FROM transactions
UNION ALL
SELECT 'price_candles_1m', COUNT(*) FROM price_candles_1m
UNION ALL
SELECT 'technical_scores', COUNT(*) FROM technical_scores
UNION ALL
SELECT 'holder_scores', COUNT(*) FROM holder_scores
UNION ALL
SELECT 'holder_snapshots', COUNT(*) FROM holder_snapshots
UNION ALL
SELECT 'token_holders', COUNT(*) FROM token_holders
UNION ALL
SELECT 'wallet_analysis_cache', COUNT(*) FROM wallet_analysis_cache
UNION ALL
SELECT 'sol_usd_prices', COUNT(*) FROM sol_usd_prices
ORDER BY table_name;