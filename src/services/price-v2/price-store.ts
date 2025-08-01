import { Pool } from 'pg';
import { PriceData } from './types';
import { getDbPool } from '../../database/connection';

export class PriceStore {
  private pool: Pool;
  
  constructor(pool?: Pool) {
    this.pool = pool || getDbPool();
  }
  
  async savePrices(prices: PriceData[]): Promise<void> {
    if (prices.length === 0) return;
    
    const values = prices.map(p => [
      p.timestamp,
      p.price,
      p.source,
      p.confidence || null
    ]);
    
    const query = `
      INSERT INTO sol_usd_prices (price_time, price_usd, source, confidence)
      VALUES ${values.map((_, i) => `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4})`).join(', ')}
      ON CONFLICT (price_time, source) DO UPDATE
      SET price_usd = EXCLUDED.price_usd,
          confidence = EXCLUDED.confidence
    `;
    
    const flatValues = values.flat();
    
    try {
      await this.pool.query(query, flatValues);
    } catch (error) {
      console.error('Error saving prices to database:', error);
      throw error;
    }
  }
  
  async getLatestPrice(source?: string): Promise<PriceData | null> {
    let query = `
      SELECT price_usd, source, confidence, price_time
      FROM sol_usd_prices
    `;
    
    const params: any[] = [];
    if (source) {
      query += ' WHERE source = $1';
      params.push(source);
    }
    
    query += ' ORDER BY price_time DESC LIMIT 1';
    
    try {
      const result = await this.pool.query(query, params);
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const row = result.rows[0];
      return {
        price: parseFloat(row.price_usd),
        timestamp: row.price_time,
        source: row.source,
        confidence: row.confidence ? parseFloat(row.confidence) : undefined
      };
    } catch (error) {
      console.error('Error fetching latest price from database:', error);
      return null;
    }
  }
  
  async getAggregatedPrice(since: Date): Promise<{
    avgPrice: number;
    medianPrice: number;
    sources: string[];
    timestamp: Date;
  } | null> {
    const query = `
      WITH recent_prices AS (
        SELECT 
          price_usd,
          source,
          price_time,
          ROW_NUMBER() OVER (PARTITION BY source ORDER BY price_time DESC) as rn
        FROM sol_usd_prices
        WHERE price_time >= $1
      ),
      latest_per_source AS (
        SELECT price_usd, source, price_time
        FROM recent_prices
        WHERE rn = 1
      )
      SELECT 
        AVG(price_usd) as avg_price,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_usd) as median_price,
        array_agg(DISTINCT source) as sources,
        MAX(price_time) as latest_time
      FROM latest_per_source
    `;
    
    try {
      const result = await this.pool.query(query, [since]);
      
      if (result.rows.length === 0 || result.rows[0].avg_price === null) {
        return null;
      }
      
      const row = result.rows[0];
      return {
        avgPrice: parseFloat(row.avg_price),
        medianPrice: parseFloat(row.median_price),
        sources: row.sources,
        timestamp: row.latest_time
      };
    } catch (error) {
      console.error('Error fetching aggregated price:', error);
      return null;
    }
  }
}