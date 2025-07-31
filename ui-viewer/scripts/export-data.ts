import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

async function exportTokens() {
    try {
        const result = await pool.query(`
            SELECT 
                mint_address as "address",
                symbol,
                name,
                platform,
                initial_supply as "totalSupply",
                creator_address as "creator",
                creation_timestamp as "createdAt",
                metadata
            FROM tokens
            ORDER BY creation_timestamp DESC
            LIMIT 1000
        `);

        return result.rows;
    } catch (error) {
        console.error('Error exporting tokens:', error);
        return [];
    }
}

async function exportPools() {
    try {
        const result = await pool.query(`
            SELECT 
                p.pool_address as "address",
                t.mint_address as "tokenAddress",
                p.platform,
                p.virtual_token_reserves as "virtualTokenReserves",
                p.virtual_sol_reserves as "virtualSolReserves",
                p.real_token_reserves as "realTokenReserves",
                p.real_sol_reserves as "realSolReserves",
                p.bonding_curve_progress as "bondingCurveProgress",
                p.created_at as "createdAt"
            FROM pools p
            JOIN tokens t ON p.token_id = t.id
            ORDER BY p.created_at DESC
            LIMIT 1000
        `);

        return result.rows;
    } catch (error) {
        console.error('Error exporting pools:', error);
        return [];
    }
}

async function exportTransactions() {
    try {
        const result = await pool.query(`
            SELECT 
                t.signature,
                p.pool_address as "poolAddress",
                t.type,
                t.token_amount as "tokenAmount",
                t.sol_amount as "solAmount",
                t.user_address as "buyerSeller",
                t.block_time as "timestamp",
                t.slot
            FROM transactions t
            JOIN pools p ON t.pool_id = p.id
            WHERE t.block_time > NOW() - INTERVAL '7 days'
            ORDER BY t.block_time DESC
            LIMIT 5000
        `);

        return result.rows;
    } catch (error) {
        console.error('Error exporting transactions:', error);
        return [];
    }
}

async function exportSummaryStats() {
    try {
        const stats: any = {};

        // Token counts by platform
        const tokenCounts = await pool.query(`
            SELECT platform, COUNT(*) as count
            FROM tokens
            GROUP BY platform
        `);
        stats.tokensByPlatform = tokenCounts.rows;

        // Transaction volume last 24h
        const txVolume = await pool.query(`
            SELECT 
                type,
                COUNT(*) as count,
                SUM(sol_amount) as total_sol
            FROM transactions
            WHERE block_time > NOW() - INTERVAL '24 hours'
            GROUP BY type
        `);
        stats.recentTransactionVolume = txVolume.rows;

        // New tokens last 24h
        const newTokens = await pool.query(`
            SELECT COUNT(*) as count
            FROM tokens
            WHERE creation_timestamp > NOW() - INTERVAL '24 hours'
        `);
        stats.newTokens24h = newTokens.rows[0].count;

        return stats;
    } catch (error) {
        console.error('Error exporting summary stats:', error);
        return {};
    }
}

async function exportAllData() {
    console.log('Starting data export...');
    
    const exportTime = new Date().toISOString();
    const dataDir = path.join(__dirname, '..', 'data');

    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    try {
        // Export tokens
        console.log('Exporting tokens...');
        const tokens = await exportTokens();
        fs.writeFileSync(
            path.join(dataDir, 'tokens.json'),
            JSON.stringify({ data: tokens, exportTime }, null, 2)
        );
        console.log(`Exported ${tokens.length} tokens`);

        // Export pools
        console.log('Exporting pools...');
        const pools = await exportPools();
        fs.writeFileSync(
            path.join(dataDir, 'pools.json'),
            JSON.stringify({ data: pools, exportTime }, null, 2)
        );
        console.log(`Exported ${pools.length} pools`);

        // Export transactions
        console.log('Exporting transactions...');
        const transactions = await exportTransactions();
        fs.writeFileSync(
            path.join(dataDir, 'transactions.json'),
            JSON.stringify({ data: transactions, exportTime }, null, 2)
        );
        console.log(`Exported ${transactions.length} transactions`);

        // Export summary stats
        console.log('Exporting summary stats...');
        const stats = await exportSummaryStats();
        fs.writeFileSync(
            path.join(dataDir, 'stats.json'),
            JSON.stringify({ data: stats, exportTime }, null, 2)
        );

        console.log('Data export completed successfully!');
        console.log(`Data saved to: ${dataDir}`);
    } catch (error) {
        console.error('Error during export:', error);
    } finally {
        await pool.end();
    }
}

// Run export
exportAllData();