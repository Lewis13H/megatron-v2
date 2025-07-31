import { getDbPool } from '../../database/connection';

export interface SolPriceData {
    price: number;
    source: string;
    confidence?: number;
    timestamp: Date;
}

export interface SolPriceService {
    getCurrentPrice(): Promise<SolPriceData>;
    getHistoricalPrice(timestamp: Date): Promise<SolPriceData | null>;
    savePriceUpdate(price: number, source: string, confidence?: number): Promise<void>;
    subscribeToUpdates(callback: (price: SolPriceData) => void): void;
    unsubscribe(): void;
}

export abstract class BaseSolPriceService implements SolPriceService {
    protected pool = getDbPool();
    protected updateCallbacks: ((price: SolPriceData) => void)[] = [];
    
    abstract getCurrentPrice(): Promise<SolPriceData>;
    
    async getHistoricalPrice(timestamp: Date): Promise<SolPriceData | null> {
        try {
            const result = await this.pool.query(
                `SELECT price_usd, source, confidence, price_time 
                 FROM sol_usd_prices 
                 WHERE price_time <= $1 
                 ORDER BY price_time DESC 
                 LIMIT 1`,
                [timestamp]
            );
            
            if (result.rows.length === 0) {
                return null;
            }
            
            const row = result.rows[0];
            return {
                price: parseFloat(row.price_usd),
                source: row.source,
                confidence: row.confidence ? parseFloat(row.confidence) : undefined,
                timestamp: row.price_time
            };
        } catch (error) {
            console.error('Error fetching historical price:', error);
            return null;
        }
    }
    
    async savePriceUpdate(price: number, source: string, confidence?: number): Promise<void> {
        try {
            await this.pool.query(
                `INSERT INTO sol_usd_prices (price_time, price_usd, source, confidence)
                 VALUES (NOW(), $1, $2, $3)
                 ON CONFLICT (price_time, source) DO UPDATE
                 SET price_usd = EXCLUDED.price_usd,
                     confidence = EXCLUDED.confidence`,
                [price, source, confidence]
            );
            
            // Notify subscribers
            const priceData: SolPriceData = {
                price,
                source,
                confidence,
                timestamp: new Date()
            };
            
            this.updateCallbacks.forEach(callback => {
                try {
                    callback(priceData);
                } catch (error) {
                    console.error('Error in price update callback:', error);
                }
            });
        } catch (error) {
            console.error('Error saving price update:', error);
            throw error;
        }
    }
    
    subscribeToUpdates(callback: (price: SolPriceData) => void): void {
        this.updateCallbacks.push(callback);
    }
    
    unsubscribe(): void {
        this.updateCallbacks = [];
    }
    
    async getLatestPriceFromDb(source?: string): Promise<SolPriceData | null> {
        try {
            let query = `SELECT price_usd, source, confidence, price_time 
                        FROM sol_usd_prices`;
            const params: any[] = [];
            
            if (source) {
                query += ` WHERE source = $1`;
                params.push(source);
            }
            
            query += ` ORDER BY price_time DESC LIMIT 1`;
            
            const result = await this.pool.query(query, params);
            
            if (result.rows.length === 0) {
                return null;
            }
            
            const row = result.rows[0];
            return {
                price: parseFloat(row.price_usd),
                source: row.source,
                confidence: row.confidence ? parseFloat(row.confidence) : undefined,
                timestamp: row.price_time
            };
        } catch (error) {
            console.error('Error fetching latest price from DB:', error);
            return null;
        }
    }
}