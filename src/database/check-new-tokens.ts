import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

async function checkNewTokens() {
    try {
        // Check tokens created in the last hour
        const result = await pool.query(`
            SELECT 
                t.symbol,
                t.name,
                t.mint_address,
                p.bonding_curve_address,
                p.latest_price,
                p.bonding_curve_progress,
                p.virtual_sol_reserves,
                p.virtual_token_reserves,
                p.created_at as pool_created,
                p.updated_at as pool_updated
            FROM tokens t
            LEFT JOIN pools p ON t.id = p.token_id
            WHERE t.platform = 'pumpfun'
                AND t.created_at > NOW() - INTERVAL '1 hour'
            ORDER BY t.created_at DESC
            LIMIT 10
        `);

        console.log('\n=== Recently Created Pump.fun Tokens ===\n');
        
        for (const row of result.rows) {
            console.log(`Token: ${row.symbol} (${row.name})`);
            console.log(`Mint: ${row.mint_address}`);
            console.log(`Pool: ${row.bonding_curve_address || 'NOT CREATED'}`);
            console.log(`Price: ${row.latest_price || 'NO TRADES YET'}`);
            console.log(`Progress: ${row.bonding_curve_progress ? row.bonding_curve_progress + '%' : 'NO TRADES YET'}`);
            console.log(`Virtual Reserves: SOL=${row.virtual_sol_reserves || 'N/A'}, Tokens=${row.virtual_token_reserves || 'N/A'}`);
            console.log(`Pool Updated: ${row.pool_updated || 'Never'}`);
            console.log('---');
        }

        if (result.rows.length === 0) {
            console.log('No tokens created in the last hour.');
        }

    } catch (error) {
        console.error('Error checking tokens:', error);
    } finally {
        await pool.end();
    }
}

checkNewTokens();