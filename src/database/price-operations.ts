import { Pool } from 'pg';
import { getDbPool } from './connection';

export interface PriceCandle {
  token_id: string;
  bucket: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_token: number;
  volume_sol: number;
  trade_count: number;
  buyer_count: number;
  seller_count: number;
}

export interface LatestPrice {
  price: number;
  bucket: Date;
  volume_sol_1h: number;
  trade_count_1h: number;
}

export interface PriceChange {
  current_price: number;
  previous_price: number;
  price_change: number;
  price_change_percent: number;
}

export interface VolumeStats {
  token_id: string;
  volume_sol_1h: number;
  volume_sol_24h: number;
  trade_count_1h: number;
  trade_count_24h: number;
  unique_traders_1h: number;
  unique_traders_24h: number;
}

export class PriceOperations {
  private pool: Pool;

  constructor() {
    this.pool = getDbPool();
  }

  /**
   * Get latest price data for a token
   */
  async getLatestPrice(tokenId: string): Promise<LatestPrice | null> {
    const query = `SELECT * FROM get_latest_price($1)`;
    const result = await this.pool.query(query, [tokenId]);
    
    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      price: parseFloat(row.price),
      bucket: new Date(row.bucket_time),
      volume_sol_1h: parseFloat(row.volume_sol_1h || '0'),
      trade_count_1h: parseInt(row.trade_count_1h || '0')
    };
  }

  /**
   * Get price change over a specific interval
   */
  async getPriceChange(tokenId: string, interval: string = '1 hour'): Promise<PriceChange | null> {
    const query = `SELECT * FROM get_price_change($1, $2::interval)`;
    const result = await this.pool.query(query, [tokenId, interval]);
    
    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      current_price: parseFloat(row.current_price),
      previous_price: parseFloat(row.previous_price),
      price_change: parseFloat(row.price_change),
      price_change_percent: parseFloat(row.price_change_percent)
    };
  }

  /**
   * Get price candles for a token within a time range
   */
  async getPriceCandles(
    tokenId: string,
    startTime: Date,
    endTime: Date = new Date()
  ): Promise<PriceCandle[]> {
    const query = `
      SELECT 
        token_id,
        bucket,
        open,
        high,
        low,
        close,
        volume_token,
        volume_sol,
        trade_count,
        buyer_count,
        seller_count
      FROM price_candles_1m_cagg
      WHERE token_id = $1
        AND bucket >= $2
        AND bucket <= $3
      ORDER BY bucket ASC
    `;

    const result = await this.pool.query(query, [tokenId, startTime, endTime]);
    
    return result.rows.map(row => ({
      token_id: row.token_id,
      bucket: new Date(row.bucket),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume_token: parseFloat(row.volume_token),
      volume_sol: parseFloat(row.volume_sol),
      trade_count: parseInt(row.trade_count),
      buyer_count: parseInt(row.buyer_count),
      seller_count: parseInt(row.seller_count)
    }));
  }

  /**
   * Get volume statistics for a token
   */
  async getVolumeStats(tokenId: string): Promise<VolumeStats | null> {
    const query = `
      WITH hourly_stats AS (
        SELECT 
          sum(sol_amount) as volume_sol_1h,
          count(*) as trade_count_1h,
          count(DISTINCT user_address) as unique_traders_1h
        FROM transactions
        WHERE token_id = $1
          AND block_time > NOW() - INTERVAL '1 hour'
          AND type IN ('buy', 'sell')
      ),
      daily_stats AS (
        SELECT 
          sum(sol_amount) as volume_sol_24h,
          count(*) as trade_count_24h,
          count(DISTINCT user_address) as unique_traders_24h
        FROM transactions
        WHERE token_id = $1
          AND block_time > NOW() - INTERVAL '24 hours'
          AND type IN ('buy', 'sell')
      )
      SELECT 
        $1::UUID as token_id,
        COALESCE(h.volume_sol_1h, 0) as volume_sol_1h,
        COALESCE(d.volume_sol_24h, 0) as volume_sol_24h,
        COALESCE(h.trade_count_1h, 0) as trade_count_1h,
        COALESCE(d.trade_count_24h, 0) as trade_count_24h,
        COALESCE(h.unique_traders_1h, 0) as unique_traders_1h,
        COALESCE(d.unique_traders_24h, 0) as unique_traders_24h
      FROM hourly_stats h
      CROSS JOIN daily_stats d
    `;

    const result = await this.pool.query(query, [tokenId]);
    
    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      token_id: row.token_id,
      volume_sol_1h: parseFloat(row.volume_sol_1h),
      volume_sol_24h: parseFloat(row.volume_sol_24h),
      trade_count_1h: parseInt(row.trade_count_1h),
      trade_count_24h: parseInt(row.trade_count_24h),
      unique_traders_1h: parseInt(row.unique_traders_1h),
      unique_traders_24h: parseInt(row.unique_traders_24h)
    };
  }

  /**
   * Get top volume tokens
   */
  async getTopVolumeTokens(limit: number = 20): Promise<any[]> {
    const query = `
      SELECT 
        t.mint_address,
        t.symbol,
        t.name,
        t.platform,
        stats.token_id,
        stats.volume_sol_1h,
        stats.trade_count_1h,
        stats.avg_price_1h,
        stats.high_1h,
        stats.low_1h,
        CASE 
          WHEN stats.low_1h > 0 AND stats.low_1h < 1000000 THEN 
            LEAST(9999999.99, ((stats.high_1h - stats.low_1h) / stats.low_1h * 100))::NUMERIC(10,2)
          ELSE 0
        END as volatility_1h
      FROM (
        SELECT 
          token_id,
          sum(volume_sol) as volume_sol_1h,
          sum(trade_count) as trade_count_1h,
          avg(close) as avg_price_1h,
          max(high) as high_1h,
          min(low) as low_1h
        FROM price_candles_1m_cagg
        WHERE bucket > NOW() - INTERVAL '1 hour'
        GROUP BY token_id
        HAVING sum(volume_sol) > 1  -- At least 1 SOL volume
      ) stats
      JOIN tokens t ON stats.token_id = t.id
      ORDER BY stats.volume_sol_1h DESC
      LIMIT $1
    `;

    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  /**
   * Validate price candle accuracy
   */
  async validatePriceCandles(tokenId: string, timeRange: string = '1 hour'): Promise<{
    isValid: boolean;
    discrepancies: any[];
    summary: any;
  }> {
    // Get raw transaction data
    const rawQuery = `
      WITH raw_data AS (
        SELECT 
          time_bucket('1 minute', block_time) as minute,
          COUNT(*) as tx_count,
          MIN(price_per_token) as min_price,
          MAX(price_per_token) as max_price,
          SUM(CASE WHEN type IN ('buy', 'sell') THEN sol_amount ELSE 0 END) as volume_sol,
          COUNT(DISTINCT CASE WHEN type = 'buy' THEN user_address END) as buyer_count
        FROM transactions
        WHERE token_id = $1
          AND block_time > NOW() - INTERVAL '${timeRange}'
          AND price_per_token IS NOT NULL
        GROUP BY minute
      ),
      candle_data AS (
        SELECT 
          bucket as minute,
          trade_count,
          low as min_price,
          high as max_price,
          volume_sol,
          buyer_count
        FROM price_candles_1m_cagg
        WHERE token_id = $1
          AND bucket > NOW() - INTERVAL '${timeRange}'
      )
      SELECT 
        COALESCE(r.minute, c.minute) as minute,
        r.tx_count as raw_count,
        c.trade_count as candle_count,
        r.min_price as raw_min,
        c.min_price as candle_min,
        r.max_price as raw_max,
        c.max_price as candle_max,
        r.volume_sol as raw_volume,
        c.volume_sol as candle_volume,
        ABS(COALESCE(r.volume_sol, 0) - COALESCE(c.volume_sol, 0)) as volume_diff
      FROM raw_data r
      FULL OUTER JOIN candle_data c ON r.minute = c.minute
      ORDER BY minute DESC
    `;

    const result = await this.pool.query(rawQuery, [tokenId]);
    
    const discrepancies = result.rows.filter(row => {
      // Check for significant differences
      const countMismatch = row.raw_count !== row.candle_count;
      const priceMismatch = Math.abs(parseFloat(row.raw_min || 0) - parseFloat(row.candle_min || 0)) > 0.000001;
      const volumeMismatch = parseFloat(row.volume_diff) > 0.01; // 0.01 SOL tolerance
      
      return countMismatch || priceMismatch || volumeMismatch;
    });

    const summary = {
      total_candles: result.rows.length,
      discrepancy_count: discrepancies.length,
      accuracy_rate: ((result.rows.length - discrepancies.length) / result.rows.length * 100).toFixed(2) + '%'
    };

    return {
      isValid: discrepancies.length === 0,
      discrepancies: discrepancies.slice(0, 10), // Return first 10 discrepancies
      summary
    };
  }

  /**
   * Force refresh continuous aggregate for a specific time range
   */
  async refreshPriceCandles(startTime?: Date, endTime?: Date): Promise<void> {
    const query = `CALL refresh_continuous_aggregate('price_candles_1m_cagg', $1::timestamptz, $2::timestamptz)`;
    
    const start = startTime || new Date(Date.now() - 24 * 60 * 60 * 1000); // Default: 24 hours ago
    const end = endTime || new Date();
    
    await this.pool.query(query, [start.toISOString(), end.toISOString()]);
  }

  /**
   * Get price trends for multiple tokens
   */
  async getMultiTokenPriceTrends(tokenIds: string[]): Promise<Map<string, PriceChange>> {
    const results = new Map<string, PriceChange>();
    
    // Process in batches to avoid parameter limits
    const batchSize = 50;
    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const batch = tokenIds.slice(i, i + batchSize);
      const placeholders = batch.map((_, idx) => `$${idx + 1}`).join(',');
      
      const query = `
        WITH latest_prices AS (
          SELECT DISTINCT ON (token_id)
            token_id,
            close as current_price,
            bucket
          FROM price_candles_1m_cagg
          WHERE token_id = ANY($1::uuid[])
          ORDER BY token_id, bucket DESC
        ),
        hour_ago_prices AS (
          SELECT DISTINCT ON (token_id)
            token_id,
            close as previous_price
          FROM price_candles_1m_cagg
          WHERE token_id = ANY($1::uuid[])
            AND bucket <= NOW() - INTERVAL '1 hour'
          ORDER BY token_id, bucket DESC
        )
        SELECT 
          lp.token_id,
          lp.current_price,
          COALESCE(hp.previous_price, lp.current_price) as previous_price,
          lp.current_price - COALESCE(hp.previous_price, lp.current_price) as price_change,
          CASE 
            WHEN COALESCE(hp.previous_price, 0) > 0 
            THEN ((lp.current_price - hp.previous_price) / hp.previous_price * 100)::NUMERIC(10,2)
            ELSE 0
          END as price_change_percent
        FROM latest_prices lp
        LEFT JOIN hour_ago_prices hp ON lp.token_id = hp.token_id
      `;
      
      const result = await this.pool.query(query, [batch]);
      
      for (const row of result.rows) {
        results.set(row.token_id, {
          current_price: parseFloat(row.current_price),
          previous_price: parseFloat(row.previous_price),
          price_change: parseFloat(row.price_change),
          price_change_percent: parseFloat(row.price_change_percent)
        });
      }
    }
    
    return results;
  }
}

// Export singleton instance
export const priceOperations = new PriceOperations();