import { readFileSync } from 'fs';
import { join } from 'path';
import { getDbPool } from '../connection';

async function setupPhase2USD() {
    console.log('Setting up Phase 2 USD enhancements...');
    const pool = getDbPool();
    
    try {
        // Read and execute the SQL script
        const sqlPath = join(__dirname, '08-phase2-usd-enhancements.sql');
        const sql = readFileSync(sqlPath, 'utf-8');
        
        await pool.query(sql);
        
        console.log('✓ Created update_price_candle_usd_values function');
        console.log('✓ Created get_token_stats_with_usd function');
        console.log('✓ Created top_tokens_by_usd_volume materialized view');
        console.log('✓ Created get_price_candles_with_usd function');
        console.log('✓ Created usd_calculation_health view');
        
        // Test the new functions
        console.log('\nTesting new functions...');
        
        // Check USD calculation health
        const healthCheck = await pool.query('SELECT * FROM usd_calculation_health');
        if (healthCheck.rows.length > 0) {
            const health = healthCheck.rows[0];
            console.log('\nUSD Calculation Health:');
            console.log(`  Transactions: ${health.transactions_with_usd}/${health.total_transactions} (${health.transaction_usd_coverage_pct}%)`);
            console.log(`  Price Candles: ${health.candles_with_usd}/${health.total_candles} (${health.candle_usd_coverage_pct}%)`);
        }
        
        // Check if we have any price data to test with
        const tokenCheck = await pool.query(`
            SELECT token_id, COUNT(*) as candle_count
            FROM price_candles_1m
            WHERE bucket > NOW() - INTERVAL '1 hour'
            GROUP BY token_id
            LIMIT 1
        `);
        
        if (tokenCheck.rows.length > 0) {
            const testTokenId = tokenCheck.rows[0].token_id;
            console.log(`\nTesting with token: ${testTokenId}`);
            
            // Test get_token_stats_with_usd
            const stats = await pool.query('SELECT * FROM get_token_stats_with_usd($1)', [testTokenId]);
            if (stats.rows.length > 0) {
                const s = stats.rows[0];
                console.log('\nToken Stats with USD:');
                console.log(`  Latest Price: ${parseFloat(s.latest_price_sol).toFixed(6)} SOL / $${parseFloat(s.latest_price_usd || 0).toFixed(2)} USD`);
                console.log(`  24h Volume: ${parseFloat(s.volume_24h_sol).toFixed(2)} SOL / $${parseFloat(s.volume_24h_usd || 0).toFixed(2)} USD`);
            }
        }
        
        console.log('\n✅ Phase 2 USD enhancements setup complete!');
        
    } catch (error) {
        console.error('Error setting up Phase 2 USD enhancements:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run if called directly
if (require.main === module) {
    setupPhase2USD().catch(console.error);
}

export { setupPhase2USD };