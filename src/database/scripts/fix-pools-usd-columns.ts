import fs from 'fs';
import path from 'path';
import { getDbPool } from '../connection';

async function fixPoolsUsdColumns() {
    const pool = getDbPool();
    
    try {
        console.log('Adding USD columns to pools table...');
        
        const sql = fs.readFileSync(
            path.join(__dirname, 'fix-pools-usd-columns.sql'),
            'utf8'
        );
        
        await pool.query(sql);
        
        console.log('✅ Successfully added USD columns to pools table');
        
        // Verify the columns exist
        const result = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'pools' 
            AND column_name IN ('initial_price_usd', 'latest_price_usd')
        `);
        
        console.log('\nVerified columns:');
        result.rows.forEach(row => {
            console.log(`  - ${row.column_name}: ${row.data_type}`);
        });
        
    } catch (error) {
        console.error('Error adding USD columns:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

fixPoolsUsdColumns().catch(console.error);