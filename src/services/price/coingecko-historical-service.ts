import { BaseSolPriceService, SolPriceData } from './sol-price-service';
import { getDbPool } from '../../database/connection';
import { Pool } from 'pg';

const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const SOLANA_ID = 'solana';

interface CoinGeckoHistoricalData {
    prices: [number, number][]; // [timestamp, price]
}

export class CoinGeckoHistoricalService extends BaseSolPriceService {
    private cgPool: Pool;
    private rateLimit = {
        callsPerMinute: 30, // Free tier limit
        lastCall: 0,
        callCount: 0
    };
    
    constructor() {
        super();
        this.cgPool = getDbPool();
    }
    
    async getCurrentPrice(): Promise<SolPriceData> {
        try {
            await this.enforceRateLimit();
            
            const response = await fetch(
                `${COINGECKO_API}/simple/price?ids=${SOLANA_ID}&vs_currencies=usd`
            );
            
            if (!response.ok) {
                throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
            }
            
            const data: any = await response.json();
            const price = data[SOLANA_ID]?.usd;
            
            if (!price) {
                throw new Error('No price data for Solana in CoinGecko response');
            }
            
            const priceData: SolPriceData = {
                price,
                source: 'coingecko',
                timestamp: new Date()
            };
            
            await this.savePriceUpdate(price, 'coingecko');
            return priceData;
            
        } catch (error) {
            console.error('Error fetching price from CoinGecko:', error);
            throw error;
        }
    }
    
    async getHistoricalPrices(
        startDate: Date,
        endDate: Date,
        interval: 'hourly' | 'daily' = 'hourly'
    ): Promise<SolPriceData[]> {
        try {
            await this.enforceRateLimit();
            
            const from = Math.floor(startDate.getTime() / 1000);
            const to = Math.floor(endDate.getTime() / 1000);
            
            // CoinGecko uses different endpoints based on date range
            const daysDiff = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
            
            let url: string;
            if (daysDiff <= 1) {
                // Use market_chart for recent data (up to 90 days)
                url = `${COINGECKO_API}/coins/${SOLANA_ID}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
            } else if (daysDiff <= 90) {
                // Use market_chart for up to 90 days
                url = `${COINGECKO_API}/coins/${SOLANA_ID}/market_chart?vs_currency=usd&days=${Math.ceil(daysDiff)}&interval=${interval}`;
            } else {
                // Use history for specific date (limited to daily data)
                console.warn('CoinGecko free tier only provides daily data for ranges > 90 days');
                url = `${COINGECKO_API}/coins/${SOLANA_ID}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
            }
            
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
            }
            
            const data = await response.json() as CoinGeckoHistoricalData;
            
            if (!data.prices || data.prices.length === 0) {
                throw new Error('No historical price data in CoinGecko response');
            }
            
            // Convert to our format
            const priceData: SolPriceData[] = data.prices.map(([timestamp, price]) => ({
                price,
                source: 'coingecko',
                timestamp: new Date(timestamp)
            }));
            
            return priceData;
            
        } catch (error) {
            console.error('Error fetching historical prices from CoinGecko:', error);
            throw error;
        }
    }
    
    async backfillHistoricalPrices(
        startDate: Date,
        endDate: Date,
        batchSize: number = 100
    ): Promise<number> {
        try {
            console.log(`Fetching historical SOL/USD prices from ${startDate.toISOString()} to ${endDate.toISOString()}`);
            
            // Determine appropriate interval based on date range
            const daysDiff = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
            const interval = daysDiff <= 7 ? 'hourly' : 'daily';
            
            const prices = await this.getHistoricalPrices(startDate, endDate, interval);
            console.log(`Fetched ${prices.length} historical prices`);
            
            // Insert in batches
            let inserted = 0;
            for (let i = 0; i < prices.length; i += batchSize) {
                const batch = prices.slice(i, i + batchSize);
                
                // Build batch insert query
                const values = batch.map((price, idx) => {
                    const offset = idx * 4;
                    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
                }).join(', ');
                
                const params = batch.flatMap(price => [
                    price.timestamp,
                    price.price,
                    price.source,
                    price.confidence
                ]);
                
                const query = `
                    INSERT INTO sol_usd_prices (price_time, price_usd, source, confidence)
                    VALUES ${values}
                    ON CONFLICT (price_time, source) DO UPDATE
                    SET price_usd = EXCLUDED.price_usd,
                        confidence = EXCLUDED.confidence
                `;
                
                await this.cgPool.query(query, params);
                inserted += batch.length;
                
                console.log(`  Inserted ${inserted}/${prices.length} prices...`);
                
                // Rate limit between batches
                await this.sleep(2000); // 2 second delay
            }
            
            console.log(`✓ Backfilled ${inserted} historical SOL/USD prices`);
            return inserted;
            
        } catch (error) {
            console.error('Error backfilling historical prices:', error);
            throw error;
        }
    }
    
    private async enforceRateLimit(): Promise<void> {
        const now = Date.now();
        const timeSinceLastCall = now - this.rateLimit.lastCall;
        
        // Reset counter if more than a minute has passed
        if (timeSinceLastCall > 60000) {
            this.rateLimit.callCount = 0;
        }
        
        // Check if we've hit the limit
        if (this.rateLimit.callCount >= this.rateLimit.callsPerMinute) {
            const waitTime = 60000 - timeSinceLastCall;
            console.log(`Rate limit reached, waiting ${waitTime}ms`);
            await this.sleep(waitTime);
            this.rateLimit.callCount = 0;
        }
        
        this.rateLimit.lastCall = now;
        this.rateLimit.callCount++;
    }
    
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}