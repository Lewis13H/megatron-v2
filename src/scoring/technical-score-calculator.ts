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
  calculatedAt: Date;
}

export interface TechnicalScoreBreakdown {
  // Market Cap Components
  marketCap: {
    positionScore: number;
    velocityScore: number;
    total: number;
    currentValue: number;
    optimalRange: string;
  };
  
  // Bonding Curve Components
  bondingCurve: {
    velocityScore: number;
    consistencyScore: number;
    positionScore: number;
    total: number;
    currentProgress: number;
    velocityPerHour: number;
  };
  
  // Trading Health Components
  tradingHealth: {
    buySellRatioScore: number;
    volumeTrendScore: number;
    distributionScore: number;
    total: number;
    currentRatio: number;
    volumeTrend: number;
    whaleConcentration: number;
  };
  
  // Sell-off Response Components
  selloffResponse: {
    sellPressureScore: number;
    recoveryScore: number;
    total: number;
    priceDropPercent: number;
    recoveryStrength: number;
    isActive: boolean;
  };
}

export class TechnicalScoreCalculator {
  private pool: Pool;
  private scoreCache: Map<string, { score: TechnicalScoreResult; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 5000; // 5 second cache
  
  constructor() {
    this.pool = getDbPool();
  }
  
  /**
   * Calculate technical score for a token
   */
  async calculateScore(tokenId: string, poolId: string): Promise<TechnicalScoreResult> {
    // Check cache first
    const cacheKey = `${tokenId}-${poolId}`;
    const cached = this.scoreCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.score;
    }
    
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM calculate_technical_score($1::uuid, $2::uuid)',
        [tokenId, poolId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('Failed to calculate technical score');
      }
      
      const row = result.rows[0];
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
        calculatedAt: new Date()
      };
      
      // Cache the result
      this.scoreCache.set(cacheKey, { score, timestamp: Date.now() });
      
      return score;
    } finally {
      client.release();
    }
  }
  
  /**
   * Get detailed breakdown of technical score components
   */
  async getScoreBreakdown(tokenId: string, poolId: string): Promise<TechnicalScoreBreakdown> {
    const score = await this.calculateScore(tokenId, poolId);
    const client = await this.pool.connect();
    
    try {
      // Get additional metrics for breakdown
      const metricsQuery = `
        WITH recent_txns AS (
          SELECT 
            type,
            sol_amount,
            token_amount,
            price_per_token,
            block_time,
            user_address
          FROM transactions
          WHERE pool_id = $1::uuid
          AND block_time > NOW() - INTERVAL '1 hour'
        ),
        volume_metrics AS (
          SELECT 
            SUM(CASE WHEN block_time > NOW() - INTERVAL '5 minutes' THEN sol_amount ELSE 0 END) as vol_5min,
            SUM(CASE WHEN block_time > NOW() - INTERVAL '15 minutes' THEN sol_amount ELSE 0 END) as vol_15min,
            SUM(CASE WHEN block_time > NOW() - INTERVAL '30 minutes' THEN sol_amount ELSE 0 END) as vol_30min
          FROM recent_txns
        ),
        whale_concentration AS (
          SELECT 
            MAX(wallet_volume / NULLIF(total_volume, 0)) as max_concentration
          FROM (
            SELECT 
              user_address,
              SUM(sol_amount) as wallet_volume,
              SUM(SUM(sol_amount)) OVER () as total_volume
            FROM recent_txns
            GROUP BY user_address
          ) wallet_volumes
        ),
        price_metrics AS (
          SELECT 
            (MAX(price_per_token) - MIN(price_per_token)) / NULLIF(MIN(price_per_token), 0) * 100 as price_volatility,
            CASE 
              WHEN COUNT(*) > 1 THEN
                ((array_agg(price_per_token ORDER BY block_time DESC))[1] - (array_agg(price_per_token ORDER BY block_time ASC))[1]) / 
                NULLIF((array_agg(price_per_token ORDER BY block_time ASC))[1], 0) * 100
              ELSE 0
            END as price_change_percent
          FROM recent_txns
          WHERE price_per_token IS NOT NULL
        )
        SELECT 
          vm.*,
          wc.max_concentration,
          pm.*,
          p.bonding_curve_progress,
          p.latest_price_usd
        FROM volume_metrics vm
        CROSS JOIN whale_concentration wc
        CROSS JOIN price_metrics pm
        CROSS JOIN pools p
        WHERE p.id = $1::uuid
      `;
      
      const metricsResult = await client.query(metricsQuery, [poolId]);
      const metrics = metricsResult.rows[0] || {};
      
      // Calculate derived values
      const marketCapVelocity = await this.calculateMarketCapVelocity(client, poolId);
      const progressVelocity = await this.calculateProgressVelocity(client, poolId);
      const volumeTrend = this.calculateVolumeTrend(metrics);
      const recoveryStrength = await this.calculateRecoveryStrength(client, poolId);
      
      const breakdown: TechnicalScoreBreakdown = {
        marketCap: {
          positionScore: this.getMarketCapPositionScore(score.marketCapUsd || 0),
          velocityScore: this.getMarketCapVelocityScore(marketCapVelocity),
          total: score.marketCapScore,
          currentValue: score.marketCapUsd || 0,
          optimalRange: '$15,000 - $30,000'
        },
        bondingCurve: {
          velocityScore: this.getProgressVelocityScore(progressVelocity),
          consistencyScore: 12.5, // Default until we have more history
          positionScore: this.getProgressPositionScore(score.bondingCurveProgress || 0),
          total: score.bondingCurveScore,
          currentProgress: score.bondingCurveProgress || 0,
          velocityPerHour: progressVelocity
        },
        tradingHealth: {
          buySellRatioScore: this.getBuySellRatioScore(score.buySellRatio || 1),
          volumeTrendScore: this.getVolumeTrendScore(volumeTrend),
          distributionScore: this.getDistributionScore(metrics.max_concentration || 0),
          total: score.tradingHealthScore,
          currentRatio: score.buySellRatio || 1,
          volumeTrend: volumeTrend,
          whaleConcentration: metrics.max_concentration || 0
        },
        selloffResponse: {
          sellPressureScore: this.getSellPressureScore(metrics.price_change_percent || 0),
          recoveryScore: this.getRecoveryScore(recoveryStrength),
          total: score.selloffResponseScore,
          priceDropPercent: Math.max(0, -(metrics.price_change_percent || 0)),
          recoveryStrength: recoveryStrength,
          isActive: score.isSelloffActive
        }
      };
      
      return breakdown;
    } finally {
      client.release();
    }
  }
  
  /**
   * Save technical score snapshot to database
   */
  async saveScoreSnapshot(tokenId: string, poolId: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT save_technical_score($1::uuid, $2::uuid) as score_id',
        [tokenId, poolId]
      );
      return result.rows[0].score_id;
    } finally {
      client.release();
    }
  }
  
  /**
   * Get historical scores for a token
   */
  async getHistoricalScores(
    tokenId: string, 
    hours: number = 24
  ): Promise<TechnicalScoreResult[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          total_score,
          market_cap_score,
          bonding_curve_score,
          trading_health_score,
          selloff_response_score,
          market_cap_usd,
          bonding_curve_progress,
          buy_sell_ratio,
          is_selloff_active,
          calculated_at
        FROM technical_scores
        WHERE token_id = $1::uuid
        AND calculated_at > NOW() - INTERVAL '${hours} hours'
        ORDER BY calculated_at DESC
      `, [tokenId]);
      
      return result.rows.map(row => ({
        totalScore: parseFloat(row.total_score),
        marketCapScore: parseFloat(row.market_cap_score),
        bondingCurveScore: parseFloat(row.bonding_curve_score),
        tradingHealthScore: parseFloat(row.trading_health_score),
        selloffResponseScore: parseFloat(row.selloff_response_score),
        marketCapUsd: row.market_cap_usd ? parseFloat(row.market_cap_usd) : null,
        bondingCurveProgress: row.bonding_curve_progress ? parseFloat(row.bonding_curve_progress) : null,
        buySellRatio: row.buy_sell_ratio ? parseFloat(row.buy_sell_ratio) : null,
        isSelloffActive: row.is_selloff_active || false,
        calculatedAt: row.calculated_at
      }));
    } finally {
      client.release();
    }
  }
  
  /**
   * Monitor tokens and alert on significant score changes
   */
  async monitorScoreChanges(
    callback: (tokenId: string, oldScore: number, newScore: number) => void,
    threshold: number = 10
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Get all active pump.fun tokens
      const tokensResult = await client.query(`
        SELECT DISTINCT t.id as token_id, p.id as pool_id
        FROM tokens t
        JOIN pools p ON t.id = p.token_id
        WHERE t.platform = 'pumpfun'
        AND p.status = 'active'
        AND p.bonding_curve_progress < 100
      `);
      
      for (const token of tokensResult.rows) {
        const oldScoreResult = await client.query(`
          SELECT total_score 
          FROM technical_scores 
          WHERE token_id = $1::uuid 
          ORDER BY calculated_at DESC 
          LIMIT 1
        `, [token.token_id]);
        
        const oldScore = oldScoreResult.rows[0]?.total_score || 0;
        const newScoreResult = await this.calculateScore(token.token_id, token.pool_id);
        
        if (Math.abs(newScoreResult.totalScore - oldScore) >= threshold) {
          callback(token.token_id, oldScore, newScoreResult.totalScore);
        }
      }
    } finally {
      client.release();
    }
  }
  
  // Private helper methods
  
  private async calculateMarketCapVelocity(client: PoolClient, poolId: string): Promise<number> {
    const result = await client.query(`
      WITH price_history AS (
        SELECT 
          latest_price_usd,
          updated_at
        FROM pools
        WHERE id = $1::uuid
        UNION ALL
        SELECT 
          market_cap_usd / 1000000000 as latest_price_usd,
          calculated_at as updated_at
        FROM technical_scores
        WHERE pool_id = $1::uuid
        AND calculated_at > NOW() - INTERVAL '10 minutes'
      )
      SELECT 
        CASE 
          WHEN COUNT(*) > 1 THEN
            (MAX(latest_price_usd) - MIN(latest_price_usd)) / 
            NULLIF(MIN(latest_price_usd), 0) * 100 / 10 -- per minute
          ELSE 0
        END as velocity
      FROM price_history
    `, [poolId]);
    
    return result.rows[0]?.velocity || 0;
  }
  
  private async calculateProgressVelocity(client: PoolClient, poolId: string): Promise<number> {
    const result = await client.query(`
      WITH progress_history AS (
        SELECT 
          bonding_curve_progress,
          updated_at
        FROM pools
        WHERE id = $1::uuid
        UNION ALL
        SELECT 
          bonding_curve_progress,
          calculated_at as updated_at
        FROM technical_scores
        WHERE pool_id = $1::uuid
        AND calculated_at > NOW() - INTERVAL '1 hour'
      )
      SELECT 
        CASE 
          WHEN COUNT(*) > 1 AND EXTRACT(EPOCH FROM (MAX(updated_at) - MIN(updated_at))) > 0 THEN
            (MAX(bonding_curve_progress) - MIN(bonding_curve_progress)) / 
            (EXTRACT(EPOCH FROM (MAX(updated_at) - MIN(updated_at))) / 3600)
          ELSE 0
        END as velocity_per_hour
      FROM progress_history
    `, [poolId]);
    
    return result.rows[0]?.velocity_per_hour || 0;
  }
  
  private calculateVolumeTrend(metrics: any): number {
    const vol5min = parseFloat(metrics.vol_5min || 0);
    const vol30min = parseFloat(metrics.vol_30min || 0);
    
    if (vol30min === 0) return 0;
    
    // Extrapolate 5min volume to 30min and compare
    const projected30min = vol5min * 6;
    return ((projected30min - vol30min) / vol30min) * 100;
  }
  
  private async calculateRecoveryStrength(client: PoolClient, poolId: string): Promise<number> {
    const result = await client.query(`
      WITH price_drops AS (
        SELECT 
          block_time,
          price_per_token,
          LAG(price_per_token) OVER (ORDER BY block_time) as prev_price
        FROM transactions
        WHERE pool_id = $1::uuid
        AND block_time > NOW() - INTERVAL '1 hour'
        AND price_per_token IS NOT NULL
      ),
      significant_drops AS (
        SELECT block_time as drop_time
        FROM price_drops
        WHERE prev_price > 0 
        AND price_per_token < prev_price * 0.95
        ORDER BY block_time DESC
        LIMIT 5
      )
      SELECT 
        AVG(
          COALESCE(buy_volume / NULLIF(sell_volume, 0), 1)
        ) as avg_recovery_strength
      FROM (
        SELECT 
          sd.drop_time,
          SUM(CASE WHEN t.type = 'buy' AND t.block_time > sd.drop_time 
                   AND t.block_time < sd.drop_time + INTERVAL '5 minutes' 
                   THEN t.sol_amount ELSE 0 END) as buy_volume,
          SUM(CASE WHEN t.type = 'sell' AND t.block_time >= sd.drop_time - INTERVAL '1 minute'
                   AND t.block_time <= sd.drop_time 
                   THEN t.sol_amount ELSE 0 END) as sell_volume
        FROM significant_drops sd
        CROSS JOIN transactions t
        WHERE t.pool_id = $1::uuid
        GROUP BY sd.drop_time
      ) recovery_data
    `, [poolId]);
    
    return result.rows[0]?.avg_recovery_strength || 1;
  }
  
  // Scoring helper methods
  
  private getMarketCapPositionScore(marketCapUsd: number): number {
    if (marketCapUsd >= 15000 && marketCapUsd <= 30000) return 60;
    if (marketCapUsd >= 10000 && marketCapUsd < 15000) return 40;
    if (marketCapUsd > 30000 && marketCapUsd <= 50000) return 40;
    if (marketCapUsd >= 5000 && marketCapUsd < 10000) return 20;
    if (marketCapUsd > 50000 && marketCapUsd <= 100000) return 20;
    return 0;
  }
  
  private getMarketCapVelocityScore(velocityPerMin: number): number {
    if (velocityPerMin >= 0.5 && velocityPerMin <= 2) return 40;
    if (velocityPerMin >= 0.2 && velocityPerMin < 0.5) return 25;
    if (velocityPerMin > 2 && velocityPerMin <= 3) return 25;
    if (velocityPerMin > 0) return 10;
    return 0;
  }
  
  private getProgressVelocityScore(velocityPerHour: number): number {
    if (velocityPerHour >= 0.5 && velocityPerHour <= 2) return 33;
    if (velocityPerHour >= 0.3 && velocityPerHour < 0.5) return 20;
    if (velocityPerHour > 2 && velocityPerHour <= 3) return 20;
    if (velocityPerHour > 0) return 10;
    return 0;
  }
  
  private getProgressPositionScore(progress: number): number {
    if (progress >= 5 && progress <= 20) return 25;
    if (progress > 20 && progress <= 40) return 20;
    if (progress > 0 && progress < 5) return 15;
    if (progress > 40 && progress <= 60) return 10;
    return 5;
  }
  
  private getBuySellRatioScore(ratio: number): number {
    if (ratio > 2) return 30;
    if (ratio >= 1.5) return 20;
    if (ratio >= 1) return 10;
    return 0;
  }
  
  private getVolumeTrendScore(trend: number): number {
    if (trend > 50) return 25;
    if (trend > 20) return 20;
    if (trend > 0) return 10;
    return 0;
  }
  
  private getDistributionScore(whaleConcentration: number): number {
    if (whaleConcentration < 0.1) return 20;
    if (whaleConcentration < 0.2) return 15;
    if (whaleConcentration < 0.3) return 10;
    if (whaleConcentration < 0.4) return 5;
    return 0;
  }
  
  private getSellPressureScore(priceDropPercent: number): number {
    if (priceDropPercent >= 0) return 40;
    if (priceDropPercent > -10) return 30;
    if (priceDropPercent > -20) return 10;
    if (priceDropPercent > -30) return -10;
    if (priceDropPercent > -40) return -25;
    return -40;
  }
  
  private getRecoveryScore(recoveryStrength: number): number {
    if (recoveryStrength > 2) return 35;
    if (recoveryStrength > 1.5) return 25;
    if (recoveryStrength > 1) return 15;
    if (recoveryStrength > 0.5) return 5;
    return 0;
  }
}

// Export singleton instance
export const technicalScoreCalculator = new TechnicalScoreCalculator();