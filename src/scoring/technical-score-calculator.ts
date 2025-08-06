import { getDbPool } from '../database/connection';
import { Pool, PoolClient } from 'pg';

export interface TechnicalScoreResult {
  totalScore: number;
  marketCapScore: number;
  bondingCurveScore: number;
  tradingHealthScore: number;
  selloffResponseScore: number;
  marketCapUsd: number | null;
  bondingCurveProgress: number | null;
  buySellRatio: number | null;
  isSelloffActive: boolean;
  selloffDuration: number | null;
  priceDrops: {
    min5: number;
    min15: number;
    min30: number;
  };
  calculatedAt: Date;
}

export class TechnicalScoreCalculator {
  private pool: Pool;
  private scoreCache: Map<string, { score: TechnicalScoreResult; timestamp: number }> = new Map();
  private dynamicCacheTTL: Map<string, number> = new Map(); // Dynamic TTL per token
  private readonly DEFAULT_CACHE_TTL_MS = 5000; // 5 seconds default
  private readonly SELLOFF_CACHE_TTL_MS = 1000; // 1 second during sell-offs
  private selloffTokens: Set<string> = new Set(); // Tokens in active sell-off
  
  constructor() {
    this.pool = getDbPool();
    // Periodic cleanup of sell-off list
    setInterval(() => this.cleanupSelloffList(), 60000); // Every minute
  }
  
  /**
   * Calculate technical score with dynamic caching based on market conditions
   */
  async calculateScore(tokenId: string, poolId: string): Promise<TechnicalScoreResult> {
    const cacheKey = `${tokenId}-${poolId}`;
    
    // Check if token is in active sell-off (bypass cache or use shorter TTL)
    const cacheTTL = this.selloffTokens.has(tokenId) 
      ? this.SELLOFF_CACHE_TTL_MS 
      : (this.dynamicCacheTTL.get(cacheKey) || this.DEFAULT_CACHE_TTL_MS);
    
    const cached = this.scoreCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cacheTTL) {
      return cached.score;
    }
    
    const client = await this.pool.connect();
    try {
      // Use technical score function with sell-off detection
      const result = await client.query(
        'SELECT * FROM calculate_technical_score($1::uuid, $2::uuid)',
        [tokenId, poolId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('Failed to calculate technical score');
      }
      
      // Get detailed sell-off metrics
      const selloffResult = await client.query(
        'SELECT * FROM calculate_selloff_response_score($1::uuid)',
        [poolId]
      );
      
      const row = result.rows[0];
      const selloffData = selloffResult.rows[0] || {};
      
      const score: TechnicalScoreResult = {
        totalScore: parseFloat(row.total_score),
        marketCapScore: parseFloat(row.market_cap_score),
        bondingCurveScore: parseFloat(row.bonding_curve_score),
        tradingHealthScore: parseFloat(row.trading_health_score),
        selloffResponseScore: parseFloat(row.selloff_response_score),
        marketCapUsd: row.market_cap_usd ? parseFloat(row.market_cap_usd) : null,
        bondingCurveProgress: row.bonding_curve_progress ? parseFloat(row.bonding_curve_progress) : null,
        buySellRatio: row.buy_sell_ratio ? parseFloat(row.buy_sell_ratio) : null,
        isSelloffActive: row.is_selloff_active || false,
        selloffDuration: selloffData.selloff_duration || null,
        priceDrops: {
          min5: selloffData.price_drop_5min || 0,
          min15: selloffData.price_drop_15min || 0,
          min30: selloffData.price_drop_30min || 0
        },
        calculatedAt: new Date()
      };
      
      // Update sell-off tracking
      if (score.isSelloffActive) {
        this.selloffTokens.add(tokenId);
        // Track sell-off event in database
        await this.trackSelloffEvent(client, poolId, score.marketCapUsd);
      } else {
        this.selloffTokens.delete(tokenId);
      }
      
      // Adjust cache TTL based on market volatility
      const volatility = Math.max(
        Math.abs(score.priceDrops.min5),
        Math.abs(score.priceDrops.min15) / 2
      );
      
      let newCacheTTL = this.DEFAULT_CACHE_TTL_MS;
      if (volatility > 20) {
        newCacheTTL = 500; // 0.5 seconds for extreme volatility
      } else if (volatility > 10) {
        newCacheTTL = 1000; // 1 second for high volatility
      } else if (volatility > 5) {
        newCacheTTL = 2000; // 2 seconds for moderate volatility
      }
      
      this.dynamicCacheTTL.set(cacheKey, newCacheTTL);
      
      // Cache the result
      this.scoreCache.set(cacheKey, { score, timestamp: Date.now() });
      
      return score;
    } finally {
      client.release();
    }
  }
  
  /**
   * Track sell-off events for pattern recognition
   */
  private async trackSelloffEvent(client: PoolClient, poolId: string, currentPrice: number | null): Promise<void> {
    if (!currentPrice) return;
    
    try {
      await client.query(
        'SELECT detect_selloff_event($1::uuid, $2::numeric)',
        [poolId, currentPrice]
      );
    } catch (error) {
      console.error('Error tracking sell-off event:', error);
    }
  }
  
  /**
   * Monitor for rapid score changes and alert
   */
  async monitorRapidChanges(
    callback: (tokenId: string, change: number, reason: string) => void,
    intervalMs: number = 5000
  ): Promise<void> {
    const monitoredTokens = new Map<string, number>(); // tokenId -> lastScore
    
    setInterval(async () => {
      const client = await this.pool.connect();
      try {
        // Get all active pump.fun tokens
        const tokensResult = await client.query(`
          SELECT DISTINCT t.id as token_id, p.id as pool_id, t.symbol
          FROM tokens t
          JOIN pools p ON t.id = p.token_id
          WHERE t.platform = 'pumpfun'
          AND p.status = 'active'
          AND p.bonding_curve_progress < 100
          AND (
            -- Recent activity
            EXISTS (
              SELECT 1 FROM transactions tx
              WHERE tx.pool_id = p.id
              AND tx.block_time > NOW() - INTERVAL '5 minutes'
            )
            OR
            -- In active sell-off
            EXISTS (
              SELECT 1 FROM selloff_events se
              WHERE se.pool_id = p.id
              AND se.is_active = TRUE
            )
          )
        `);
        
        for (const token of tokensResult.rows) {
          const newScore = await this.calculateScore(token.token_id, token.pool_id);
          const lastScore = monitoredTokens.get(token.token_id);
          
          if (lastScore !== undefined) {
            const change = newScore.totalScore - lastScore;
            
            // Alert on significant changes
            if (Math.abs(change) >= 10) {
              let reason = 'Unknown';
              
              if (newScore.isSelloffActive && change < 0) {
                reason = `Sell-off detected: ${newScore.priceDrops.min5.toFixed(1)}% drop`;
              } else if (!newScore.isSelloffActive && change > 0) {
                reason = 'Recovery from sell-off';
              } else if (change > 0 && newScore.buySellRatio! > 2) {
                reason = 'Strong buying pressure';
              } else if (change < 0 && newScore.buySellRatio! < 0.5) {
                reason = 'Heavy selling pressure';
              }
              
              callback(token.token_id, change, `${token.symbol}: ${reason}`);
            }
          }
          
          monitoredTokens.set(token.token_id, newScore.totalScore);
        }
      } finally {
        client.release();
      }
    }, intervalMs);
  }
  
  /**
   * Get real-time market sentiment across all tokens
   */
  async getMarketSentiment(): Promise<{
    bullishTokens: number;
    bearishTokens: number;
    neutralTokens: number;
    activeSelloffs: number;
    averageScore: number;
  }> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        WITH latest_scores AS (
          SELECT DISTINCT ON (token_id)
            token_id,
            total_score,
            is_selloff_active,
            selloff_response_score
          FROM technical_scores
          WHERE calculated_at > NOW() - INTERVAL '5 minutes'
          ORDER BY token_id, calculated_at DESC
        )
        SELECT 
          COUNT(CASE WHEN total_score > 200 THEN 1 END) as bullish,
          COUNT(CASE WHEN total_score < 100 THEN 1 END) as bearish,
          COUNT(CASE WHEN total_score BETWEEN 100 AND 200 THEN 1 END) as neutral,
          COUNT(CASE WHEN is_selloff_active THEN 1 END) as active_selloffs,
          AVG(total_score) as avg_score
        FROM latest_scores
      `);
      
      const row = result.rows[0];
      return {
        bullishTokens: parseInt(row.bullish) || 0,
        bearishTokens: parseInt(row.bearish) || 0,
        neutralTokens: parseInt(row.neutral) || 0,
        activeSelloffs: parseInt(row.active_selloffs) || 0,
        averageScore: parseFloat(row.avg_score) || 0
      };
    } finally {
      client.release();
    }
  }
  
  /**
   * Clean up sell-off list periodically
   */
  private async cleanupSelloffList(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // End stale sell-off events (> 1 hour old)
      await client.query(`
        UPDATE selloff_events
        SET is_active = FALSE, end_time = NOW()
        WHERE is_active = TRUE
        AND start_time < NOW() - INTERVAL '1 hour'
      `);
      
      // Get list of tokens no longer in sell-off
      const result = await client.query(`
        SELECT DISTINCT t.id as token_id
        FROM tokens t
        JOIN pools p ON t.id = p.token_id
        WHERE t.id = ANY($1::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM selloff_events se
          WHERE se.pool_id = p.id
          AND se.is_active = TRUE
        )
      `, [Array.from(this.selloffTokens)]);
      
      // Remove from local tracking
      for (const row of result.rows) {
        this.selloffTokens.delete(row.token_id);
      }
    } finally {
      client.release();
    }
  }
  
  /**
   * Get detailed sell-off history for a token
   */
  async getSelloffHistory(tokenId: string, hours: number = 24): Promise<any[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          se.*,
          p.pool_address,
          EXTRACT(EPOCH FROM (COALESCE(se.end_time, NOW()) - se.start_time)) / 60 as duration_minutes,
          (se.start_price - se.lowest_price) / se.start_price * 100 as max_drop_percent,
          CASE 
            WHEN se.recovery_price IS NOT NULL THEN
              (se.recovery_price - se.lowest_price) / se.lowest_price * 100
            ELSE NULL
          END as recovery_percent
        FROM selloff_events se
        JOIN pools p ON se.pool_id = p.id
        WHERE p.token_id = $1::uuid
        AND se.start_time > NOW() - INTERVAL '${hours} hours'
        ORDER BY se.start_time DESC
      `, [tokenId]);
      
      return result.rows;
    } finally {
      client.release();
    }
  }
}

// Export singleton instance
export const technicalScoreCalculator = new TechnicalScoreCalculator();