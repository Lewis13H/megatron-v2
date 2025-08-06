import { technicalScoreCalculator } from '../../scoring/technical-score-calculator';
import { monitorService } from '../../database';
import { getDbPool } from '../../database/connection';

interface PriceUpdate {
  poolId: string;
  tokenId: string;
  price: number;
  timestamp: Date;
  type: 'buy' | 'sell';
  volume: number;
}

interface SellPressureAlert {
  tokenId: string;
  symbol: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  priceDropPercent: number;
  duration: number;
  volumeSold: number;
}

export class MonitorIntegration {
  private priceHistory: Map<string, PriceUpdate[]> = new Map();
  private alertCallbacks: ((alert: SellPressureAlert) => void)[] = [];
  private readonly PRICE_HISTORY_LIMIT = 100; // Keep last 100 price updates per token
  
  /**
   * Process price update from monitors and detect sell pressure
   */
  async processPriceUpdate(update: PriceUpdate): Promise<void> {
    // Update price history
    const key = update.poolId;
    if (!this.priceHistory.has(key)) {
      this.priceHistory.set(key, []);
    }
    
    const history = this.priceHistory.get(key)!;
    history.push(update);
    
    // Limit history size
    if (history.length > this.PRICE_HISTORY_LIMIT) {
      history.shift();
    }
    
    // Detect patterns
    await this.detectSellPressure(update);
    
    // Calculate and save technical score with no cache for critical updates
    if (update.type === 'sell' && update.volume > 1) { // Large sell
      const score = await technicalScoreCalculator.calculateScore(
        update.tokenId,
        update.poolId
      );
      
      // Save score snapshot if significant change
      if (score.selloffResponseScore < -20) {
        // Save technical score to database using direct query
        const pool = getDbPool();
        const client = await pool.connect();
        try {
          await client.query(
            'SELECT save_technical_score($1::uuid, $2::uuid)',
            [update.tokenId, update.poolId]
          );
        } finally {
          client.release();
        }
      }
    }
  }
  
  /**
   * Detect sell pressure patterns
   */
  private async detectSellPressure(update: PriceUpdate): Promise<void> {
    const history = this.priceHistory.get(update.poolId);
    if (!history || history.length < 5) return;
    
    const recentHistory = history.slice(-20); // Last 20 transactions
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    // Calculate metrics
    const recentSells = recentHistory.filter(h => h.type === 'sell' && h.timestamp > fiveMinAgo);
    const recentBuys = recentHistory.filter(h => h.type === 'buy' && h.timestamp > fiveMinAgo);
    
    if (recentSells.length === 0) return;
    
    const totalSellVolume = recentSells.reduce((sum, s) => sum + s.volume, 0);
    const totalBuyVolume = recentBuys.reduce((sum, b) => sum + b.volume, 0);
    
    // Price drop calculation
    const oldestPrice = history[0].price;
    const currentPrice = update.price;
    const priceDropPercent = ((oldestPrice - currentPrice) / oldestPrice) * 100;
    
    // Determine severity
    let severity: SellPressureAlert['severity'] = 'low';
    if (priceDropPercent > 30 || totalSellVolume > 10) {
      severity = 'critical';
    } else if (priceDropPercent > 20 || totalSellVolume > 5) {
      severity = 'high';
    } else if (priceDropPercent > 10 || totalSellVolume > 2) {
      severity = 'medium';
    }
    
    // Check for whale dump (single large sell)
    const whaleDump = recentSells.find(s => s.volume > 5); // > 5 SOL
    if (whaleDump) {
      severity = 'critical';
    }
    
    // Check for coordinated selling (multiple sells in short time)
    const sellsLastMinute = recentSells.filter(
      s => s.timestamp > new Date(Date.now() - 60 * 1000)
    );
    if (sellsLastMinute.length > 5) {
      severity = severity === 'low' ? 'medium' : severity;
    }
    
    // Fire alert if significant
    if (severity !== 'low' && priceDropPercent > 5) {
      const tokenInfo = await this.getTokenInfo(update.tokenId);
      const alert: SellPressureAlert = {
        tokenId: update.tokenId,
        symbol: tokenInfo?.symbol || 'UNKNOWN',
        severity,
        priceDropPercent,
        duration: Math.floor((Date.now() - recentSells[0].timestamp.getTime()) / 1000 / 60), // minutes
        volumeSold: totalSellVolume
      };
      
      this.fireAlert(alert);
    }
  }
  
  /**
   * Register alert callback
   */
  onSellPressureAlert(callback: (alert: SellPressureAlert) => void): void {
    this.alertCallbacks.push(callback);
  }
  
  /**
   * Fire alert to all registered callbacks
   */
  private fireAlert(alert: SellPressureAlert): void {
    for (const callback of this.alertCallbacks) {
      try {
        callback(alert);
      } catch (error) {
        console.error('Error in alert callback:', error);
      }
    }
  }
  
  /**
   * Get token info from database
   */
  private async getTokenInfo(tokenId: string): Promise<any> {
    try {
      const pool = getDbPool();
      const client = await pool.connect();
      try {
        const result = await client.query(
          'SELECT * FROM tokens WHERE id = $1::uuid',
          [tokenId]
        );
        return result.rows[0] || null;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error fetching token info:', error);
      return null;
    }
  }
  
  /**
   * Analyze sell pressure recovery
   */
  async analyzeRecovery(poolId: string): Promise<{
    isRecovering: boolean;
    recoveryStrength: number;
    timeToRecover: number | null;
  }> {
    const history = this.priceHistory.get(poolId);
    if (!history || history.length < 10) {
      return { isRecovering: false, recoveryStrength: 0, timeToRecover: null };
    }
    
    // Find the lowest point in recent history
    let lowestPrice = history[0].price;
    let lowestIndex = 0;
    
    for (let i = 1; i < history.length; i++) {
      if (history[i].price < lowestPrice) {
        lowestPrice = history[i].price;
        lowestIndex = i;
      }
    }
    
    // Check if we're past the lowest point
    if (lowestIndex === history.length - 1) {
      return { isRecovering: false, recoveryStrength: 0, timeToRecover: null };
    }
    
    // Calculate recovery metrics
    const currentPrice = history[history.length - 1].price;
    const recoveryPercent = ((currentPrice - lowestPrice) / lowestPrice) * 100;
    
    // Count buy vs sell since lowest point
    const recoverySells = history.slice(lowestIndex).filter(h => h.type === 'sell').length;
    const recoveryBuys = history.slice(lowestIndex).filter(h => h.type === 'buy').length;
    const recoveryRatio = recoveryBuys / Math.max(recoverySells, 1);
    
    // Estimate time to full recovery
    const preDropPrice = history[0].price;
    const recoveryRate = recoveryPercent / (history.length - lowestIndex); // % per transaction
    const remainingRecovery = ((preDropPrice - currentPrice) / currentPrice) * 100;
    const estimatedTransactionsToRecover = remainingRecovery / Math.max(recoveryRate, 0.1);
    
    return {
      isRecovering: recoveryPercent > 5 && recoveryRatio > 1,
      recoveryStrength: recoveryRatio,
      timeToRecover: estimatedTransactionsToRecover * 30 // Assume 30 seconds per transaction
    };
  }
  
  /**
   * Get current market state for a token
   */
  async getMarketState(poolId: string, tokenId: string): Promise<{
    state: 'bullish' | 'bearish' | 'neutral' | 'recovering';
    confidence: number;
    signals: string[];
  }> {
    const history = this.priceHistory.get(poolId);
    const score = await technicalScoreCalculator.calculateScore(tokenId, poolId);
    const recovery = await this.analyzeRecovery(poolId);
    
    const signals: string[] = [];
    let state: 'bullish' | 'bearish' | 'neutral' | 'recovering' = 'neutral';
    let confidence = 0;
    
    // Analyze technical score
    if (score.totalScore > 250) {
      state = 'bullish';
      confidence += 30;
      signals.push('High technical score');
    } else if (score.totalScore < 100) {
      state = 'bearish';
      confidence += 30;
      signals.push('Low technical score');
    }
    
    // Check sell-off status
    if (score.isSelloffActive) {
      state = 'bearish';
      confidence += 20;
      signals.push(`Active sell-off (${score.priceDrops.min5.toFixed(1)}% drop)`);
    }
    
    // Check recovery
    if (recovery.isRecovering) {
      state = 'recovering';
      confidence += 25;
      signals.push(`Recovery detected (strength: ${recovery.recoveryStrength.toFixed(1)}x)`);
    }
    
    // Analyze buy/sell ratio
    if (score.buySellRatio) {
      if (score.buySellRatio > 2) {
        if (state !== 'bearish') state = 'bullish';
        confidence += 15;
        signals.push('Strong buying pressure');
      } else if (score.buySellRatio < 0.5) {
        if (state !== 'recovering') state = 'bearish';
        confidence += 15;
        signals.push('Heavy selling pressure');
      }
    }
    
    // Volume analysis
    if (history && history.length > 10) {
      const recentVolume = history.slice(-5).reduce((sum, h) => sum + h.volume, 0);
      const olderVolume = history.slice(-10, -5).reduce((sum, h) => sum + h.volume, 0);
      
      if (recentVolume > olderVolume * 2) {
        confidence += 10;
        signals.push('Increasing volume');
      } else if (recentVolume < olderVolume * 0.5) {
        confidence -= 10;
        signals.push('Decreasing volume');
      }
    }
    
    // Cap confidence at 100
    confidence = Math.min(100, Math.max(0, confidence));
    
    return { state, confidence, signals };
  }
}

// Export singleton instance
export const monitorIntegration = new MonitorIntegration();

// Example usage in monitors:
/*
// In pumpfun-monitor-token-price.ts
import { monitorIntegration } from './utils/monitor-integration';

// When processing a transaction
await monitorIntegration.processPriceUpdate({
  poolId: pool.id,
  tokenId: token.id,
  price: pricePerToken,
  timestamp: new Date(blockTime * 1000),
  type: transactionType,
  volume: solAmount
});

// Register for alerts
monitorIntegration.onSellPressureAlert((alert) => {
  console.log(`⚠️ SELL PRESSURE ALERT [${alert.severity.toUpperCase()}]`);
  console.log(`Token: ${alert.symbol}`);
  console.log(`Price Drop: ${alert.priceDropPercent.toFixed(2)}%`);
  console.log(`Duration: ${alert.duration} minutes`);
  console.log(`Volume Sold: ${alert.volumeSold.toFixed(2)} SOL`);
});
*/