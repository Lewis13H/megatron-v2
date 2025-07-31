-- Fix the backfill_transaction_usd_values function to use signature instead of id

CREATE OR REPLACE FUNCTION backfill_transaction_usd_values(
    p_start_time TIMESTAMPTZ DEFAULT NULL,
    p_end_time TIMESTAMPTZ DEFAULT NULL,
    p_batch_size INT DEFAULT 1000
)
RETURNS TABLE(updated_count INT) AS $$
DECLARE
    v_updated INT := 0;
    v_total_updated INT := 0;
BEGIN
    LOOP
        WITH batch AS (
            SELECT t.signature, t.block_time, t.price_per_token, t.sol_amount
            FROM transactions t
            WHERE (t.price_per_token_usd IS NULL OR t.sol_amount_usd IS NULL)
                AND (p_start_time IS NULL OR t.block_time >= p_start_time)
                AND (p_end_time IS NULL OR t.block_time <= p_end_time)
            LIMIT p_batch_size
            FOR UPDATE SKIP LOCKED
        )
        UPDATE transactions t
        SET 
            price_per_token_usd = t.price_per_token * get_sol_usd_price(b.block_time),
            sol_amount_usd = (t.sol_amount / 1e9) * get_sol_usd_price(b.block_time)
        FROM batch b
        WHERE t.signature = b.signature
            AND get_sol_usd_price(b.block_time) > 0;
        
        GET DIAGNOSTICS v_updated = ROW_COUNT;
        v_total_updated := v_total_updated + v_updated;
        
        EXIT WHEN v_updated = 0;
        
        -- Sleep briefly to avoid overwhelming the database
        PERFORM pg_sleep(0.1);
    END LOOP;
    
    RETURN QUERY SELECT v_total_updated;
END;
$$ LANGUAGE plpgsql;