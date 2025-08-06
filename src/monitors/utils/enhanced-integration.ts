import { technicalScoreCalculator } from '../../scoring/technical-score-calculator';
import { getDbPool } from '../../database/connection';
import EventEmitter from 'events';

export interface ScoreUpdateEvent {
  tokenId: string;
  poolId: string;
  oldScore: number;
  newScore: number;
  scoreBreakdown: any;
  timestamp: Date;
}

export class PumpfunMonitorIntegration extends EventEmitter {
  private pool = getDbPool();
  private scoreUpdateQueue: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_TIME = 5000; // 5 seconds
  private readonly SCORE_CHANGE_THRESHOLD = 10; // 10 point change triggers event
  
  constructor() {
    super();
  }
  
  /**
   * Process new token creation and calculate initial score
   */
  async onNewTokenCreated(tokenData: any): Promise<void> {
    try {
      // Wait a bit for initial transactions to come in
      setTimeout(async () => {
        const poolData = await this.getPoolData(tokenData.mint || tokenData.Ca);
        if (poolData) {
          await this.calculateAndSaveScore(poolData.token_id, poolData.id);
        }
      }, 10000); // Wait 10 seconds for initial data
    } catch (error) {
      console.error('Error processing new token:', error);
    }
  }
  
  /**
   * Process price updates and recalculate scores
   */
  async onPriceUpdate(priceData: any): Promise<void> {
    try {
      const poolData = await this.getPoolDataByBondingCurve(priceData.bonding_curve);
      if (!poolData) return;
      
      // Debounce score calculations
      this.debounceScoreCalculation(poolData.token_id, poolData.id);
      
      // Check for significant price drops (potential sell-off)
      if (priceData.type === 'sell' && priceData.sol_amount > 1) {
        // Large sell detected, calculate score immediately
        this.cancelDebounce(poolData.token_id);
        await this.calculateAndEmitScore(poolData.token_id, poolData.id, true);
      }
    } catch (error) {
      console.error('Error processing price update:', error);
    }
  }
  
  /**
   * Process account updates (bonding curve state changes)
   */
  async onAccountUpdate(accountData: any): Promise<void> {
    try {
      const poolData = await this.getPoolDataByBondingCurve(accountData.bondingCurveAddress);
      if (!poolData) return;
      
      // Check if bonding curve progress crossed a milestone
      const milestones = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90];
      const previousProgress = poolData.bonding_curve_progress || 0;
      const newProgress = accountData.bondingCurveProgress || 0;
      
      const crossedMilestone = milestones.some(
        milestone => previousProgress < milestone && newProgress >= milestone
      );
      
      if (crossedMilestone) {
        await this.calculateAndEmitScore(poolData.token_id, poolData.id, true);
      } else {
        this.debounceScoreCalculation(poolData.token_id, poolData.id);
      }
    } catch (error) {
      console.error('Error processing account update:', error);
    }
  }
  
  /**
   * Process transaction and update scores if needed
   */
  async onTransaction(transactionData: any): Promise<void> {
    try {
      // For large transactions, recalculate immediately
      if (transactionData.sol_amount > 5) {
        const poolData = await this.getPoolDataByTransaction(transactionData.signature);
        if (poolData) {
          await this.calculateAndEmitScore(poolData.token_id, poolData.id, true);
        }
      }
    } catch (error) {
      console.error('Error processing transaction:', error);
    }
  }
  
  /**
   * Start monitoring all active pump.fun tokens
   */
  async startContinuousMonitoring(intervalMs: number = 60000): Promise<void> {
    console.log('🚀 Starting continuous technical score monitoring...');
    
    setInterval(async () => {
      try {
        await technicalScoreCalculator.monitorScoreChanges(
          async (tokenId, oldScore, newScore) => {
            const poolData = await this.getPoolDataByTokenId(tokenId);
            if (poolData) {
              const breakdown = await technicalScoreCalculator.getScoreBreakdown(tokenId, poolData.id);
              
              this.emit('scoreChange', {
                tokenId,
                poolId: poolData.id,
                oldScore,
                newScore,
                scoreBreakdown: breakdown,
                timestamp: new Date()
              } as ScoreUpdateEvent);
              
              // Save snapshot if significant change
              if (Math.abs(newScore - oldScore) >= this.SCORE_CHANGE_THRESHOLD) {
                await technicalScoreCalculator.saveScoreSnapshot(tokenId, poolData.id);
              }
            }
          },
          this.SCORE_CHANGE_THRESHOLD
        );
      } catch (error) {
        console.error('Error in continuous monitoring:', error);
      }
    }, intervalMs);
  }
  
  /**
   * Get tokens with scores in specific range
   */
  async getTokensByScoreRange(minScore: number, maxScore: number): Promise<any[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          ts.*,
          t.symbol,
          t.name,
          t.mint_address,
          p.pool_address,
          p.bonding_curve_address,
          p.latest_price_usd,
          p.bonding_curve_progress
        FROM latest_technical_scores ts
        JOIN tokens t ON ts.token_id = t.id
        JOIN pools p ON ts.pool_id = p.id
        WHERE ts.total_score >= $1 AND ts.total_score <= $2
        AND p.status = 'active'
        ORDER BY ts.total_score DESC
      `, [minScore, maxScore]);
      
      return result.rows;
    } finally {
      client.release();
    }
  }
  
  /**
   * Get tokens in optimal entry range ($15-30k market cap)
   */
  async getOptimalEntryTokens(): Promise<any[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          ts.*,
          t.symbol,
          t.name,
          t.mint_address,
          p.pool_address,
          p.bonding_curve_address,
          p.latest_price_usd,
          p.bonding_curve_progress
        FROM latest_technical_scores ts
        JOIN tokens t ON ts.token_id = t.id
        JOIN pools p ON ts.pool_id = p.id
        WHERE ts.market_cap_usd >= 15000 
        AND ts.market_cap_usd <= 30000
        AND ts.total_score >= 200
        AND p.status = 'active'
        AND NOT ts.is_selloff_active
        ORDER BY ts.total_score DESC
        LIMIT 20
      `);
      
      return result.rows;
    } finally {
      client.release();
    }
  }
  
  /**
   * Get tokens experiencing sell-offs
   */
  async getSelloffTokens(): Promise<any[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          ts.*,
          t.symbol,
          t.name,
          t.mint_address,
          p.pool_address,
          p.latest_price_usd,
          p.bonding_curve_progress
        FROM latest_technical_scores ts
        JOIN tokens t ON ts.token_id = t.id
        JOIN pools p ON ts.pool_id = p.id
        WHERE ts.is_selloff_active = true
        AND p.status = 'active'
        ORDER BY ts.selloff_response_score DESC
      `);
      
      return result.rows;
    } finally {
      client.release();
    }
  }
  
  // Private helper methods
  
  private debounceScoreCalculation(tokenId: string, poolId: string): void {
    const key = `${tokenId}-${poolId}`;
    
    // Cancel existing timeout
    this.cancelDebounce(tokenId);
    
    // Set new timeout
    const timeout = setTimeout(async () => {
      await this.calculateAndEmitScore(tokenId, poolId);
      this.scoreUpdateQueue.delete(key);
    }, this.DEBOUNCE_TIME);
    
    this.scoreUpdateQueue.set(key, timeout);
  }
  
  private cancelDebounce(tokenId: string): void {
    for (const [key, timeout] of this.scoreUpdateQueue.entries()) {
      if (key.startsWith(tokenId)) {
        clearTimeout(timeout);
        this.scoreUpdateQueue.delete(key);
      }
    }
  }
  
  private async calculateAndSaveScore(tokenId: string, poolId: string): Promise<void> {
    try {
      await technicalScoreCalculator.saveScoreSnapshot(tokenId, poolId);
    } catch (error) {
      console.error('Error saving score snapshot:', error);
    }
  }
  
  private async calculateAndEmitScore(
    tokenId: string, 
    poolId: string, 
    saveSnapshot: boolean = false
  ): Promise<void> {
    try {
      // Get previous score
      const history = await technicalScoreCalculator.getHistoricalScores(tokenId, 1);
      const oldScore = history[0]?.totalScore || 0;
      
      // Calculate new score
      const newScore = await technicalScoreCalculator.calculateScore(tokenId, poolId);
      
      // Emit if significant change
      if (Math.abs(newScore.totalScore - oldScore) >= 5) {
        const breakdown = await technicalScoreCalculator.getScoreBreakdown(tokenId, poolId);
        
        this.emit('scoreChange', {
          tokenId,
          poolId,
          oldScore,
          newScore: newScore.totalScore,
          scoreBreakdown: breakdown,
          timestamp: new Date()
        } as ScoreUpdateEvent);
      }
      
      // Save snapshot if requested
      if (saveSnapshot) {
        await this.calculateAndSaveScore(tokenId, poolId);
      }
    } catch (error) {
      console.error('Error calculating and emitting score:', error);
    }
  }
  
  private async getPoolData(mintAddress: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT p.*, t.id as token_id
        FROM pools p
        JOIN tokens t ON p.token_id = t.id
        WHERE p.base_mint = $1
        LIMIT 1
      `, [mintAddress]);
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }
  
  private async getPoolDataByBondingCurve(bondingCurveAddress: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT p.*, t.id as token_id
        FROM pools p
        JOIN tokens t ON p.token_id = t.id
        WHERE p.bonding_curve_address = $1
        LIMIT 1
      `, [bondingCurveAddress]);
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }
  
  private async getPoolDataByTransaction(signature: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT p.*, t.id as token_id
        FROM transactions tx
        JOIN pools p ON tx.pool_id = p.id
        JOIN tokens t ON p.token_id = t.id
        WHERE tx.signature = $1
        LIMIT 1
      `, [signature]);
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }
  
  private async getPoolDataByTokenId(tokenId: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT p.*, t.id as token_id
        FROM pools p
        JOIN tokens t ON p.token_id = t.id
        WHERE t.id = $1::uuid
        AND p.platform = 'pumpfun'
        LIMIT 1
      `, [tokenId]);
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }
}

// Export singleton instance
export const pumpfunIntegration = new PumpfunMonitorIntegration();

// Example usage in monitors:
/*
// In pumpfun-monitor-new-token-mint.ts:
import { pumpfunIntegration } from '../utils/enhanced-integration';
// After saving token:
await pumpfunIntegration.onNewTokenCreated(tokenData);

// In pumpfun-monitor-token-price.ts:
import { pumpfunIntegration } from '../utils/enhanced-integration';
// After price update:
await pumpfunIntegration.onPriceUpdate(formattedSwapTxn);

// In pump-fun-monitor-account.ts:
import { pumpfunIntegration } from '../utils/enhanced-integration';
// After account update:
await pumpfunIntegration.onAccountUpdate(accountData);

// Listen for score changes:
pumpfunIntegration.on('scoreChange', (event: ScoreUpdateEvent) => {
  console.log(`📊 Score Update for ${event.tokenId}:`);
  console.log(`   Old Score: ${event.oldScore}`);
  console.log(`   New Score: ${event.newScore}`);
  console.log(`   Market Cap: $${event.scoreBreakdown.marketCap.currentValue}`);
  console.log(`   Sell-off Active: ${event.scoreBreakdown.selloffResponse.isActive}`);
});
*/