/**
 * Score Integration for Pump.fun Monitors
 * Calculates and saves technical scores when price/transaction updates occur
 */

import { technicalScoreCalculator } from '../../../scoring/technical-score-calculator';
import { getDbPool } from '../../../database/connection';

export class ScoreIntegration {
  private pool = getDbPool();
  private lastScoreTime = new Map<string, number>();
  private MIN_SCORE_INTERVAL_MS = 5000; // Minimum 5 seconds between score calculations
  
  /**
   * Calculate and save technical score for a token
   */
  async calculateAndSaveScore(
    tokenId: string, 
    poolId: string,
    trigger: 'price' | 'transaction' | 'account'
  ): Promise<void> {
    try {
      // Check if we recently calculated score for this token
      const lastTime = this.lastScoreTime.get(tokenId);
      if (lastTime && Date.now() - lastTime < this.MIN_SCORE_INTERVAL_MS) {
        console.log(`⏭️ Skipping score calculation for ${tokenId} - too soon (${trigger})`);
        return; // Skip if calculated recently
      }
      
      console.log(`📊 Calculating technical score for token ${tokenId} (triggered by ${trigger})`)
      
      // Calculate the score using the technical score calculator
      const scoreResult = await technicalScoreCalculator.calculateScore(tokenId, poolId);
      
      // Save to technical_scores table
      const client = await this.pool.connect();
      try {
        await client.query(`
          INSERT INTO technical_scores (
            token_id,
            pool_id,
            total_score,
            market_cap_score,
            bonding_curve_score,
            trading_health_score,
            selloff_response_score,
            market_cap_usd,
            bonding_curve_progress,
            buy_sell_ratio,
            volume_5min,
            volume_15min,
            volume_30min,
            is_selloff_active,
            price_drop_15min,
            price_drop_30min,
            selloff_duration_minutes,
            calculated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
        `, [
          tokenId,
          poolId,
          scoreResult.totalScore,
          scoreResult.marketCapScore,
          scoreResult.bondingCurveScore,
          scoreResult.tradingHealthScore,
          scoreResult.selloffResponseScore,
          scoreResult.marketCapUsd,
          scoreResult.bondingCurveProgress,
          scoreResult.buySellRatio,
          null, // volume_5min - could be calculated separately
          null, // volume_15min
          null, // volume_30min
          scoreResult.isSelloffActive,
          scoreResult.priceDrops.min15,
          scoreResult.priceDrops.min30,
          scoreResult.selloffDuration,
        ]);
        
        // Update last score time
        this.lastScoreTime.set(tokenId, Date.now());
        
        // Log significant score changes
        if (scoreResult.totalScore < 50) {
          console.log(`⚠️ Low score for token ${tokenId}: ${scoreResult.totalScore.toFixed(1)} (triggered by ${trigger})`);
        } else if (scoreResult.totalScore > 120) {
          console.log(`🎯 High score for token ${tokenId}: ${scoreResult.totalScore.toFixed(1)} (triggered by ${trigger})`);
        }
        
        // Alert on sell-off detection
        if (scoreResult.isSelloffActive) {
          console.log(`🔴 SELL-OFF DETECTED for token ${tokenId}!`);
          console.log(`   Price drops: 5min=${scoreResult.priceDrops.min5.toFixed(1)}%, 15min=${scoreResult.priceDrops.min15.toFixed(1)}%`);
        }
        
      } finally {
        client.release();
      }
      
    } catch (error) {
      console.error(`Error calculating/saving technical score for token ${tokenId}:`, error);
    }
  }
  
  /**
   * Get token and pool IDs from mint address
   */
  async getTokenAndPoolIds(mintAddress: string): Promise<{ tokenId: string | null, poolId: string | null }> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT t.id as token_id, p.id as pool_id
        FROM tokens t
        LEFT JOIN pools p ON t.id = p.token_id
        WHERE t.mint_address = $1
        AND p.status = 'active'
        ORDER BY p.created_at DESC
        LIMIT 1
      `, [mintAddress]);
      
      if (result.rows.length > 0) {
        return {
          tokenId: result.rows[0].token_id,
          poolId: result.rows[0].pool_id
        };
      }
      
      return { tokenId: null, poolId: null };
    } finally {
      client.release();
    }
  }
  
  /**
   * Handle price update event
   */
  async onPriceUpdate(mintAddress: string, price: number, bondingCurveProgress?: number): Promise<void> {
    const { tokenId, poolId } = await this.getTokenAndPoolIds(mintAddress);
    
    if (tokenId && poolId) {
      console.log(`💰 Price update for ${mintAddress} -> Token: ${tokenId}, Pool: ${poolId}`);
      // Price updates are high priority - calculate score
      await this.calculateAndSaveScore(tokenId, poolId, 'price');
    } else {
      console.log(`⚠️ Could not find token/pool for mint ${mintAddress}`);
    }
  }
  
  /**
   * Handle transaction event (buy/sell)
   */
  async onTransaction(mintAddress: string, type: 'buy' | 'sell', solAmount: number): Promise<void> {
    const { tokenId, poolId } = await this.getTokenAndPoolIds(mintAddress);
    
    if (tokenId && poolId) {
      // Large transactions trigger immediate score calculation
      if (solAmount > 5) {
        console.log(`🐋 Whale ${type}: ${solAmount.toFixed(2)} SOL`);
        await this.calculateAndSaveScore(tokenId, poolId, 'transaction');
      } else if (solAmount > 1) {
        // Smaller transactions use throttling
        await this.calculateAndSaveScore(tokenId, poolId, 'transaction');
      }
    }
  }
  
  /**
   * Handle account update event
   */
  async onAccountUpdate(mintAddress: string): Promise<void> {
    const { tokenId, poolId } = await this.getTokenAndPoolIds(mintAddress);
    
    if (tokenId && poolId) {
      // Account updates are lower priority - use throttling
      await this.calculateAndSaveScore(tokenId, poolId, 'account');
    }
  }
  
  /**
   * Clean up old score entries
   */
  async cleanupOldScores(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Keep only last 24 hours of scores per token
      await client.query(`
        DELETE FROM technical_scores
        WHERE calculated_at < NOW() - INTERVAL '24 hours'
      `);
    } finally {
      client.release();
    }
  }
}

// Export singleton instance
export const scoreIntegration = new ScoreIntegration();