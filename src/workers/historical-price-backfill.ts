import { getDbPool } from '../database/connection';
import { CoinGeckoHistoricalService } from '../services/price/coingecko-historical-service';
import { EnhancedPriceOperations } from '../database/enhanced-price-operations';

interface BackfillOptions {
    startDate?: Date;
    endDate?: Date;
    source?: 'coingecko' | 'mock';
    dryRun?: boolean;
}

export class HistoricalPriceBackfill {
    private pool = getDbPool();
    private coinGeckoService = new CoinGeckoHistoricalService();
    private priceOps = new EnhancedPriceOperations();
    
    async run(options: BackfillOptions = {}): Promise<void> {
        const {
            startDate,
            endDate = new Date(),
            source = 'coingecko',
            dryRun = false
        } = options;
        
        console.log('Starting historical price backfill...\n');
        
        try {
            // Step 1: Determine date range
            const dateRange = await this.determineDateRange(startDate, endDate);
            console.log(`Date range: ${dateRange.start.toISOString()} to ${dateRange.end.toISOString()}`);
            console.log(`Duration: ${this.formatDuration(dateRange.end.getTime() - dateRange.start.getTime())}\n`);
            
            if (dryRun) {
                console.log('DRY RUN MODE - No data will be saved\n');
            }
            
            // Step 2: Check existing coverage
            const coverage = await this.checkExistingCoverage(dateRange.start, dateRange.end);
            console.log('Existing SOL/USD price coverage:');
            console.log(`  Total hours: ${coverage.totalHours}`);
            console.log(`  Covered hours: ${coverage.coveredHours}`);
            console.log(`  Coverage: ${coverage.coveragePercent.toFixed(1)}%`);
            console.log(`  Gaps: ${coverage.gaps.length}\n`);
            
            if (coverage.coveragePercent >= 95) {
                console.log('✓ Coverage is already sufficient (>95%)');
                return;
            }
            
            // Step 3: Fetch and backfill historical prices
            if (source === 'coingecko' && !dryRun) {
                console.log('Fetching historical prices from CoinGecko...');
                const inserted = await this.coinGeckoService.backfillHistoricalPrices(
                    dateRange.start,
                    dateRange.end
                );
                console.log(`✓ Inserted ${inserted} price records\n`);
            } else if (source === 'mock') {
                console.log('Generating mock historical prices...');
                const inserted = await this.generateMockHistoricalPrices(
                    dateRange.start,
                    dateRange.end,
                    dryRun
                );
                console.log(`✓ Generated ${inserted} mock price records\n`);
            }
            
            // Step 4: Update transactions with USD values
            console.log('Updating historical transactions with USD values...');
            const txStats = await this.updateTransactionUsdValues(dateRange.start, dateRange.end, dryRun);
            console.log(`✓ Updated ${txStats.updated} transactions`);
            console.log(`  Total value: ${txStats.totalSol.toFixed(2)} SOL / $${txStats.totalUsd.toFixed(2)} USD\n`);
            
            // Step 5: Update price candles with USD values
            console.log('Updating price candles with USD values...');
            const candleStats = await this.updatePriceCandleUsdValues(dateRange.start, dateRange.end, dryRun);
            console.log(`✓ Updated ${candleStats.updated} price candles`);
            console.log(`  Tokens affected: ${candleStats.tokensAffected}\n`);
            
            // Step 6: Verify results
            if (!dryRun) {
                console.log('Verifying backfill results...');
                const newCoverage = await this.checkExistingCoverage(dateRange.start, dateRange.end);
                console.log(`  New coverage: ${newCoverage.coveragePercent.toFixed(1)}%`);
                
                const health = await this.priceOps.getUSDCalculationHealth();
                if (health) {
                    console.log(`  Transaction USD coverage: ${health.transaction_usd_coverage_pct}%`);
                    console.log(`  Price candle USD coverage: ${health.candle_usd_coverage_pct}%`);
                }
            }
            
            console.log('\n✅ Historical price backfill completed!');
            
        } catch (error) {
            console.error('Backfill failed:', error);
            throw error;
        }
    }
    
    private async determineDateRange(startDate?: Date, endDate: Date = new Date()): Promise<{
        start: Date;
        end: Date;
    }> {
        if (startDate) {
            return { start: startDate, end: endDate };
        }
        
        // Find the earliest transaction or token creation
        const result = await this.pool.query(`
            SELECT 
                MIN(LEAST(
                    (SELECT MIN(block_time) FROM transactions),
                    (SELECT MIN(creation_timestamp) FROM tokens)
                )) as earliest_date
        `);
        
        const earliestDate = result.rows[0].earliest_date;
        if (!earliestDate) {
            throw new Error('No historical data found to backfill');
        }
        
        return {
            start: new Date(earliestDate),
            end: endDate
        };
    }
    
    private async checkExistingCoverage(startDate: Date, endDate: Date): Promise<{
        totalHours: number;
        coveredHours: number;
        coveragePercent: number;
        gaps: Array<{ start: Date; end: Date }>;
    }> {
        const result = await this.pool.query(`
            WITH hour_series AS (
                SELECT generate_series(
                    date_trunc('hour', $1::timestamptz),
                    date_trunc('hour', $2::timestamptz),
                    '1 hour'::interval
                ) as hour
            ),
            coverage AS (
                SELECT 
                    hs.hour,
                    COUNT(DISTINCT sp.source) as sources,
                    COUNT(sp.price_time) as price_count
                FROM hour_series hs
                LEFT JOIN sol_usd_prices sp ON 
                    date_trunc('hour', sp.price_time) = hs.hour
                GROUP BY hs.hour
            )
            SELECT 
                COUNT(*) as total_hours,
                COUNT(CASE WHEN price_count > 0 THEN 1 END) as covered_hours
            FROM coverage
        `, [startDate, endDate]);
        
        const stats = result.rows[0];
        const totalHours = parseInt(stats.total_hours);
        const coveredHours = parseInt(stats.covered_hours);
        
        // Find gaps (simplified - just returning empty array for now)
        const gaps: Array<{ start: Date; end: Date }> = [];
        
        return {
            totalHours,
            coveredHours,
            coveragePercent: totalHours > 0 ? (coveredHours / totalHours) * 100 : 0,
            gaps
        };
    }
    
    private async generateMockHistoricalPrices(
        startDate: Date,
        endDate: Date,
        dryRun: boolean
    ): Promise<number> {
        const hours = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60));
        let basePrice = 20; // Starting price
        let inserted = 0;
        
        for (let i = 0; i < hours; i++) {
            const timestamp = new Date(startDate.getTime() + i * 60 * 60 * 1000);
            
            // Simulate price movement
            const change = (Math.random() - 0.5) * 2; // ±$2 per hour
            basePrice = Math.max(10, Math.min(200, basePrice + change)); // Keep between $10-$200
            
            if (!dryRun) {
                await this.pool.query(`
                    INSERT INTO sol_usd_prices (price_time, price_usd, source, confidence)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (price_time, source) DO UPDATE
                    SET price_usd = EXCLUDED.price_usd
                `, [timestamp, basePrice, 'mock', Math.random() * 0.1]);
            }
            
            inserted++;
            
            if (inserted % 100 === 0) {
                console.log(`  Generated ${inserted}/${hours} prices...`);
            }
        }
        
        return inserted;
    }
    
    private async updateTransactionUsdValues(
        startDate: Date,
        endDate: Date,
        dryRun: boolean
    ): Promise<{ updated: number; totalSol: number; totalUsd: number }> {
        if (dryRun) {
            const result = await this.pool.query(`
                SELECT 
                    COUNT(*) as count,
                    COALESCE(SUM(sol_amount / 1e9), 0) as total_sol
                FROM transactions
                WHERE block_time >= $1 AND block_time <= $2
                    AND (price_per_token_usd IS NULL OR sol_amount_usd IS NULL)
            `, [startDate, endDate]);
            
            return {
                updated: parseInt(result.rows[0].count),
                totalSol: parseFloat(result.rows[0].total_sol),
                totalUsd: parseFloat(result.rows[0].total_sol) * 150 // Estimate
            };
        }
        
        const result = await this.pool.query(
            'SELECT * FROM backfill_transaction_usd_values($1, $2, 1000)',
            [startDate, endDate]
        );
        
        const updated = result.rows[0]?.updated_count || 0;
        
        // Get totals
        const totals = await this.pool.query(`
            SELECT 
                COALESCE(SUM(sol_amount / 1e9), 0) as total_sol,
                COALESCE(SUM(sol_amount_usd), 0) as total_usd
            FROM transactions
            WHERE block_time >= $1 AND block_time <= $2
                AND sol_amount_usd IS NOT NULL
        `, [startDate, endDate]);
        
        return {
            updated,
            totalSol: parseFloat(totals.rows[0].total_sol),
            totalUsd: parseFloat(totals.rows[0].total_usd)
        };
    }
    
    private async updatePriceCandleUsdValues(
        startDate: Date,
        endDate: Date,
        dryRun: boolean
    ): Promise<{ updated: number; tokensAffected: number }> {
        // Get affected tokens
        const tokenResult = await this.pool.query(`
            SELECT DISTINCT token_id
            FROM price_candles_1m
            WHERE bucket >= $1 AND bucket <= $2
                AND (open_usd IS NULL OR high_usd IS NULL OR low_usd IS NULL OR close_usd IS NULL)
        `, [startDate, endDate]);
        
        const tokensAffected = tokenResult.rows.length;
        let updated = 0;
        
        if (!dryRun) {
            for (const row of tokenResult.rows) {
                const count = await this.priceOps.updatePriceCandleUSDValues(
                    row.token_id,
                    startDate,
                    endDate
                );
                updated += count;
            }
        } else {
            const result = await this.pool.query(`
                SELECT COUNT(*) as count
                FROM price_candles_1m
                WHERE bucket >= $1 AND bucket <= $2
                    AND (open_usd IS NULL OR high_usd IS NULL OR low_usd IS NULL OR close_usd IS NULL)
            `, [startDate, endDate]);
            
            updated = parseInt(result.rows[0].count);
        }
        
        return { updated, tokensAffected };
    }
    
    private formatDuration(ms: number): string {
        const days = Math.floor(ms / (1000 * 60 * 60 * 24));
        const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        
        if (days > 0) {
            return `${days} days, ${hours} hours`;
        }
        return `${hours} hours`;
    }
    
    async cleanup(): Promise<void> {
        await this.pool.end();
    }
}

// CLI interface
if (require.main === module) {
    const args = process.argv.slice(2);
    const options: BackfillOptions = {};
    
    // Parse command line arguments
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--start':
                options.startDate = new Date(args[++i]);
                break;
            case '--end':
                options.endDate = new Date(args[++i]);
                break;
            case '--source':
                options.source = args[++i] as 'coingecko' | 'mock';
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--help':
                console.log(`
Historical Price Backfill

Usage: npm run backfill:historical [options]

Options:
  --start <date>    Start date (ISO format, default: earliest data)
  --end <date>      End date (ISO format, default: now)
  --source <type>   Price source: 'coingecko' or 'mock' (default: coingecko)
  --dry-run         Show what would be done without making changes
  --help            Show this help message

Examples:
  npm run backfill:historical --dry-run
  npm run backfill:historical --source mock --start 2024-01-01
  npm run backfill:historical --start 2024-06-01 --end 2024-07-01
                `);
                process.exit(0);
        }
    }
    
    const backfill = new HistoricalPriceBackfill();
    
    backfill.run(options)
        .then(() => backfill.cleanup())
        .catch((error) => {
            console.error('Backfill failed:', error);
            process.exit(1);
        });
}