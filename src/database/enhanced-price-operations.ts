/**
 * @deprecated This file is not actively used. Price operations with USD conversion
 * are handled by SQL functions and views in the database.
 * Consider removing this file in future cleanup.
 */
import { PriceOperations, PriceCandle } from './operations/price';

export interface PriceCandleWithUSD extends PriceCandle {
    open_usd: number;
    high_usd: number;
    low_usd: number;
    close_usd: number;
    volume_usd: number;
}

export interface TokenStatsWithUSD {
    token_id: string;
    latest_price_sol: number;
    latest_price_usd: number;
    volume_24h_sol: number;
    volume_24h_usd: number;
    high_24h_sol: number;
    high_24h_usd: number;
    low_24h_sol: number;
    low_24h_usd: number;
    price_change_24h_pct: number;
    last_updated: Date;
}

export interface TopTokenByUSD {
    token_id: string;
    name: string;
    symbol: string;
    mint_address: string;
    volume_24h_usd: number;
    latest_price_usd: number;
    active_hours: number;
}

export class EnhancedPriceOperations extends PriceOperations {
    constructor() {
        super();
    }

    async getLatestPriceWithUSD(tokenId: string): Promise<{
        price_sol: number;
        price_usd: number;
        volume_sol_1h: number;
        volume_usd_1h: number;
        timestamp: Date;
    } | null> {
        try {
            const result = await this.query(`
                WITH latest_price AS (
                    SELECT 
                        close as price_sol,
                        close_usd as price_usd,
                        bucket as timestamp
                    FROM price_candles_1m
                    WHERE token_id = $1
                    ORDER BY bucket DESC
                    LIMIT 1
                ),
                volume_1h AS (
                    SELECT 
                        COALESCE(SUM(volume_sol), 0) as volume_sol_1h,
                        COALESCE(SUM(volume_usd), 0) as volume_usd_1h
                    FROM price_candles_1m
                    WHERE token_id = $1
                        AND bucket > NOW() - INTERVAL '1 hour'
                )
                SELECT 
                    lp.price_sol,
                    COALESCE(lp.price_usd, lp.price_sol * get_sol_usd_price(lp.timestamp)) as price_usd,
                    v.volume_sol_1h,
                    v.volume_usd_1h,
                    lp.timestamp
                FROM latest_price lp
                CROSS JOIN volume_1h v
            `, [tokenId]);

            if (result.rows.length === 0) {
                return null;
            }

            const row = result.rows[0];
            return {
                price_sol: parseFloat(row.price_sol),
                price_usd: parseFloat(row.price_usd),
                volume_sol_1h: parseFloat(row.volume_sol_1h),
                volume_usd_1h: parseFloat(row.volume_usd_1h),
                timestamp: row.timestamp
            };
        } catch (error) {
            console.error('Error getting latest price with USD:', error);
            throw error;
        }
    }

    async getPriceCandlesWithUSD(
        tokenId: string,
        startTime: Date,
        endTime: Date,
        interval: string = '1 minute'
    ): Promise<PriceCandleWithUSD[]> {
        try {
            const result = await this.query(
                'SELECT * FROM get_price_candles_with_usd($1, $2, $3, $4)',
                [tokenId, interval, startTime, endTime]
            );

            return result.rows.map(row => ({
                token_id: tokenId,
                bucket: row.bucket,
                open: parseFloat(row.open_sol),
                high: parseFloat(row.high_sol),
                low: parseFloat(row.low_sol),
                close: parseFloat(row.close_sol),
                volume_sol: parseFloat(row.volume_sol),
                volume_token: 0, // Not available in aggregated data
                trade_count: row.trades,
                buyer_count: 0, // Not available in aggregated data
                seller_count: 0, // Not available in aggregated data
                open_usd: parseFloat(row.open_usd),
                high_usd: parseFloat(row.high_usd),
                low_usd: parseFloat(row.low_usd),
                close_usd: parseFloat(row.close_usd),
                volume_usd: parseFloat(row.volume_usd)
            }));
        } catch (error) {
            console.error('Error getting price candles with USD:', error);
            throw error;
        }
    }

    async getTokenStatsWithUSD(tokenId: string): Promise<TokenStatsWithUSD | null> {
        try {
            const result = await this.query(
                'SELECT * FROM get_token_stats_with_usd($1)',
                [tokenId]
            );

            if (result.rows.length === 0) {
                return null;
            }

            const row = result.rows[0];
            return {
                token_id: row.out_token_id,
                latest_price_sol: parseFloat(row.out_latest_price_sol),
                latest_price_usd: parseFloat(row.out_latest_price_usd),
                volume_24h_sol: parseFloat(row.out_volume_24h_sol),
                volume_24h_usd: parseFloat(row.out_volume_24h_usd),
                high_24h_sol: parseFloat(row.out_high_24h_sol),
                high_24h_usd: parseFloat(row.out_high_24h_usd),
                low_24h_sol: parseFloat(row.out_low_24h_sol),
                low_24h_usd: parseFloat(row.out_low_24h_usd),
                price_change_24h_pct: parseFloat(row.out_price_change_24h_pct),
                last_updated: row.out_last_updated
            };
        } catch (error) {
            console.error('Error getting token stats with USD:', error);
            throw error;
        }
    }

    async getTopTokensByUSDVolume(limit: number = 100): Promise<TopTokenByUSD[]> {
        try {
            const result = await this.query(`
                SELECT * FROM top_tokens_by_usd_volume
                LIMIT $1
            `, [limit]);

            return result.rows.map(row => ({
                token_id: row.token_id,
                name: row.name,
                symbol: row.symbol,
                mint_address: row.mint_address,
                volume_24h_usd: parseFloat(row.volume_24h_usd),
                latest_price_usd: parseFloat(row.latest_price_usd),
                active_hours: row.active_hours
            }));
        } catch (error) {
            console.error('Error getting top tokens by USD volume:', error);
            throw error;
        }
    }

    async refreshTopTokensView(): Promise<void> {
        try {
            await this.execute('SELECT refresh_top_tokens_usd()', []);
            console.log('Refreshed top tokens by USD volume view');
        } catch (error) {
            console.error('Error refreshing top tokens view:', error);
            throw error;
        }
    }

    async updatePriceCandleUSDValues(
        tokenId: string,
        startTime: Date,
        endTime: Date
    ): Promise<number> {
        try {
            const result = await this.query(
                'SELECT update_price_candle_usd_values($1, $2, $3) as updated',
                [tokenId, startTime, endTime]
            );

            return result.rows[0].updated;
        } catch (error) {
            console.error('Error updating price candle USD values:', error);
            throw error;
        }
    }

    async getUSDCalculationHealth(): Promise<{
        total_transactions: number;
        transactions_with_usd: number;
        transaction_usd_coverage_pct: number;
        total_candles: number;
        candles_with_usd: number;
        candle_usd_coverage_pct: number;
        last_transaction: Date;
        last_candle: Date;
    } | null> {
        try {
            const result = await this.query('SELECT * FROM usd_calculation_health');

            if (result.rows.length === 0) {
                return null;
            }

            const row = result.rows[0];
            return {
                total_transactions: parseInt(row.total_transactions),
                transactions_with_usd: parseInt(row.transactions_with_usd),
                transaction_usd_coverage_pct: parseFloat(row.transaction_usd_coverage_pct),
                total_candles: parseInt(row.total_candles),
                candles_with_usd: parseInt(row.candles_with_usd),
                candle_usd_coverage_pct: parseFloat(row.candle_usd_coverage_pct),
                last_transaction: row.last_transaction,
                last_candle: row.last_candle
            };
        } catch (error) {
            console.error('Error getting USD calculation health:', error);
            throw error;
        }
    }

    // Batch update all USD values for a time range
    async backfillUSDValues(startTime: Date, endTime: Date): Promise<{
        transactions_updated: number;
        candles_updated: number;
    }> {
        try {
            console.log(`Backfilling USD values from ${startTime.toISOString()} to ${endTime.toISOString()}`);

            // Update transactions
            const txResult = await this.query(
                'SELECT * FROM backfill_transaction_usd_values($1, $2, 1000)',
                [startTime, endTime]
            );
            const transactions_updated = txResult.rows[0]?.updated_count || 0;

            // Update price candles for all tokens in the range
            const tokenResult = await this.query(`
                SELECT DISTINCT token_id
                FROM price_candles_1m
                WHERE bucket >= $1 AND bucket < $2
            `, [startTime, endTime]);

            let candles_updated = 0;
            for (const tokenRow of tokenResult.rows) {
                const updated = await this.updatePriceCandleUSDValues(
                    tokenRow.token_id,
                    startTime,
                    endTime
                );
                candles_updated += updated;
            }

            console.log(`✓ Updated ${transactions_updated} transactions and ${candles_updated} price candles with USD values`);

            return {
                transactions_updated,
                candles_updated
            };
        } catch (error) {
            console.error('Error backfilling USD values:', error);
            throw error;
        }
    }
}