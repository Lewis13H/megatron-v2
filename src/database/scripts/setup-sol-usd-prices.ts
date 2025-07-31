import { readFileSync } from 'fs';
import { join } from 'path';
import { getDbPool } from '../connection';

async function setupSolUsdPrices() {
    console.log('Setting up SOL/USD price tracking tables...');
    const pool = getDbPool();
    
    try {
        // Read and execute the SQL script
        const sqlPath = join(__dirname, '07-setup-sol-usd-prices.sql');
        const sql = readFileSync(sqlPath, 'utf-8');
        
        // Execute the entire SQL script at once
        // This preserves dollar-quoted strings and complex statements
        await pool.query(sql);
        
        console.log('✓ Created sol_usd_prices table');
        console.log('✓ Added USD columns to price_candles_1m');
        console.log('✓ Added USD columns to transactions');
        console.log('✓ Created USD calculation functions and triggers');
        console.log('✓ Created sol_usd_price_health view');
        
        // Now create the continuous aggregate separately
        console.log('\nCreating continuous aggregate...');
        const caggPath = join(__dirname, '07b-setup-sol-usd-continuous-aggregate.sql');
        const caggSql = readFileSync(caggPath, 'utf-8');
        
        try {
            await pool.query(caggSql);
            console.log('✓ Created sol_usd_candles_1m continuous aggregate');
        } catch (caggError: any) {
            if (caggError.code === '42P07') { // relation already exists
                console.log('✓ sol_usd_candles_1m continuous aggregate already exists');
            } else {
                console.warn('⚠️  Failed to create continuous aggregate:', caggError.message);
                console.log('   You can create it manually later with: npm run db:setup:sol-usd-cagg');
            }
        }
        
        // Verify tables were created
        const tableCheck = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'sol_usd_prices'
        `);
        
        if (tableCheck.rows.length > 0) {
            console.log('\n✅ SOL/USD price infrastructure setup complete!');
            
            // Show column info
            const columnInfo = await pool.query(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = 'sol_usd_prices'
                ORDER BY ordinal_position
            `);
            
            console.log('\nSOL/USD prices table columns:');
            columnInfo.rows.forEach((col: any) => {
                console.log(`  - ${col.column_name}: ${col.data_type}`);
            });
        } else {
            console.error('❌ Failed to create sol_usd_prices table');
        }
        
    } catch (error) {
        console.error('Error setting up SOL/USD prices:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run if called directly
if (require.main === module) {
    setupSolUsdPrices().catch(console.error);
}

export { setupSolUsdPrices };