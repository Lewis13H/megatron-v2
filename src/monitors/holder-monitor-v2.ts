/**
 * Holder Monitor V2 - Production-Ready Integration
 * Integrates with existing Pump.fun and Raydium monitors
 * Optimized for Helius Developer Plan
 */

import { getHolderAnalysisService, HolderAnalysisService } from '../services/holder-analysis/holder-analysis-service';
import { getDbPool } from '../database/connection';
import { EventEmitter } from 'events';

interface MonitorConfig {
  heliusApiKey: string;
  enableWebSocket?: boolean;
  analysisIntervalMs?: number;
  minBondingCurveProgress?: number;
  maxBondingCurveProgress?: number;
  minHolders?: number;
  minTokenAgeMinutes?: number;
  maxConcurrentAnalysis?: number;
  alertThresholds?: AlertThresholds;
}

interface AlertThresholds {
  highConcentration?: number; // Default: 50%
  highBotRatio?: number; // Default: 30%
  highGini?: number; // Default: 0.8
  lowScore?: number; // Default: 100
  highScore?: number; // Default: 250
  highRisk?: number; // Default: 70
}

interface TokenToAnalyze {
  tokenId: string;
  mintAddress: string;
  symbol: string;
  name: string;
  bondingCurveProgress: number;
  createdAt: Date;
  platform: string;
  lastAnalyzed?: Date;
  holderCount?: number;
  transactionCount?: number;
}

interface AnalysisResult {
  token: TokenToAnalyze;
  score: {
    total: number;
    distribution: number;
    quality: number;
    activity: number;
  };
  metrics: {
    holderCount: number;
    giniCoefficient: number;
    top10Concentration: number;
    botRatio: number;
    smartMoneyRatio: number;
    overallRisk: number;
  };
  alerts: Alert[];
  timestamp: Date;
}

interface Alert {
  level: 'info' | 'warning' | 'critical';
  type: string;
  message: string;
  value?: number;
}

export class HolderMonitorV2 extends EventEmitter {
  private service: HolderAnalysisService;
  private db = getDbPool();
  private config: Required<MonitorConfig>;
  private isRunning = false;
  private analysisInterval: NodeJS.Timeout | null = null;
  private activeAnalysis = new Set<string>();
  private lastAnalysisTime = new Map<string, Date>();
  private readonly MIN_ANALYSIS_INTERVAL = 5 * 60 * 1000; // 5 minutes per token

  constructor(config: MonitorConfig) {
    super();
    
    this.config = {
      heliusApiKey: config.heliusApiKey,
      enableWebSocket: config.enableWebSocket ?? false,
      analysisIntervalMs: config.analysisIntervalMs ?? 60000, // 1 minute
      minBondingCurveProgress: config.minBondingCurveProgress ?? 10,
      maxBondingCurveProgress: config.maxBondingCurveProgress ?? 99,
      minHolders: config.minHolders ?? 5,
      minTokenAgeMinutes: config.minTokenAgeMinutes ?? 30,
      maxConcurrentAnalysis: config.maxConcurrentAnalysis ?? 5,
      alertThresholds: {
        highConcentration: config.alertThresholds?.highConcentration ?? 50,
        highBotRatio: config.alertThresholds?.highBotRatio ?? 0.3,
        highGini: config.alertThresholds?.highGini ?? 0.8,
        lowScore: config.alertThresholds?.lowScore ?? 100,
        highScore: config.alertThresholds?.highScore ?? 250,
        highRisk: config.alertThresholds?.highRisk ?? 70,
        ...config.alertThresholds
      }
    };

    this.service = getHolderAnalysisService(config.heliusApiKey);
    
    // Listen to holder updates from WebSocket
    this.service.on('holderUpdate', (data) => {
      this.handleHolderUpdate(data);
    });
  }

  // ============================================
  // Main Monitoring Loop
  // ============================================

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[HolderMonitor] Already running');
      return;
    }

    console.log('[HolderMonitor] Starting holder analysis monitor...');
    console.log(`[HolderMonitor] Configuration:`);
    console.log(`  - Bonding curve range: ${this.config.minBondingCurveProgress}-${this.config.maxBondingCurveProgress}%`);
    console.log(`  - Min holders: ${this.config.minHolders}`);
    console.log(`  - Min token age: ${this.config.minTokenAgeMinutes} minutes`);
    console.log(`  - Analysis interval: ${this.config.analysisIntervalMs}ms`);
    console.log(`  - WebSocket enabled: ${this.config.enableWebSocket}`);
    console.log(`  - Max concurrent: ${this.config.maxConcurrentAnalysis}`);

    this.isRunning = true;

    // Initial analysis
    await this.analyzeEligibleTokens();

    // Setup interval
    this.analysisInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.analyzeEligibleTokens();
      }
    }, this.config.analysisIntervalMs);

    // Track API usage
    this.startCreditTracking();

    this.emit('started');
  }

  async stop(): Promise<void> {
    console.log('[HolderMonitor] Stopping...');
    this.isRunning = false;

    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }

    await this.service.cleanup();
    
    this.emit('stopped');
    console.log('[HolderMonitor] Stopped');
  }

  // ============================================
  // Token Analysis
  // ============================================

  private async analyzeEligibleTokens(): Promise<void> {
    try {
      const tokens = await this.getEligibleTokens();
      
      if (tokens.length === 0) {
        console.log('[HolderMonitor] No eligible tokens found');
        return;
      }

      console.log(`[HolderMonitor] Found ${tokens.length} eligible tokens`);

      // Filter out recently analyzed tokens
      const toAnalyze = tokens.filter(token => {
        const lastAnalysis = this.lastAnalysisTime.get(token.mintAddress);
        if (!lastAnalysis) return true;
        return Date.now() - lastAnalysis.getTime() > this.MIN_ANALYSIS_INTERVAL;
      });

      if (toAnalyze.length === 0) {
        console.log('[HolderMonitor] All tokens recently analyzed, skipping');
        return;
      }

      // Analyze in batches respecting concurrency limit
      for (let i = 0; i < toAnalyze.length; i += this.config.maxConcurrentAnalysis) {
        const batch = toAnalyze.slice(i, i + this.config.maxConcurrentAnalysis);
        
        await Promise.allSettled(
          batch.map(token => this.analyzeToken(token))
        );

        // Small delay between batches
        if (i + this.config.maxConcurrentAnalysis < toAnalyze.length) {
          await this.sleep(1000);
        }
      }

    } catch (error) {
      console.error('[HolderMonitor] Error in analysis loop:', error);
      this.emit('error', error);
    }
  }

  private async analyzeToken(token: TokenToAnalyze): Promise<AnalysisResult | null> {
    // Check if already analyzing
    if (this.activeAnalysis.has(token.mintAddress)) {
      console.log(`[HolderMonitor] Already analyzing ${token.symbol}`);
      return null;
    }

    this.activeAnalysis.add(token.mintAddress);

    try {
      console.log(`[HolderMonitor] Analyzing ${token.symbol} (${token.bondingCurveProgress.toFixed(2)}%)`);

      // Perform analysis
      const snapshot = await this.service.analyzeToken(
        token.mintAddress,
        token.bondingCurveProgress,
        {
          useWebSocket: this.config.enableWebSocket,
          forceRefresh: false,
          includeHistoricalData: false
        }
      );

      // Calculate score
      const score = this.service.calculateHolderScore(snapshot);

      // Generate alerts
      const alerts = this.generateAlerts(token, snapshot, score);

      // Create result
      const result: AnalysisResult = {
        token,
        score: {
          total: score.total,
          distribution: score.distribution,
          quality: score.quality,
          activity: score.activity
        },
        metrics: {
          holderCount: snapshot.holderCount,
          giniCoefficient: snapshot.distribution.giniCoefficient,
          top10Concentration: snapshot.distribution.top10Percentage,
          botRatio: snapshot.walletQuality.botRatio,
          smartMoneyRatio: snapshot.walletQuality.smartMoneyRatio,
          overallRisk: snapshot.riskMetrics.overallRisk
        },
        alerts,
        timestamp: new Date()
      };

      // Update last analysis time
      this.lastAnalysisTime.set(token.mintAddress, new Date());

      // Emit events
      this.emit('analyzed', result);

      if (alerts.some(a => a.level === 'critical')) {
        this.emit('criticalAlert', result);
      }

      // Log summary
      this.logAnalysisSummary(result);

      return result;

    } catch (error) {
      console.error(`[HolderMonitor] Error analyzing ${token.symbol}:`, error);
      this.emit('analysisError', { token, error });
      return null;

    } finally {
      this.activeAnalysis.delete(token.mintAddress);
    }
  }

  // ============================================
  // Alert Generation
  // ============================================

  private generateAlerts(token: TokenToAnalyze, snapshot: any, score: any): Alert[] {
    const alerts: Alert[] = [];
    const thresholds = this.config.alertThresholds;

    // Concentration alerts
    if (snapshot.distribution.top10Percentage > thresholds.highConcentration) {
      alerts.push({
        level: 'critical',
        type: 'concentration',
        message: `High concentration: Top 10 holders own ${snapshot.distribution.top10Percentage.toFixed(1)}%`,
        value: snapshot.distribution.top10Percentage
      });
    }

    if (snapshot.distribution.top1Percentage > 30) {
      alerts.push({
        level: 'critical',
        type: 'whale',
        message: `Single whale owns ${snapshot.distribution.top1Percentage.toFixed(1)}%`,
        value: snapshot.distribution.top1Percentage
      });
    }

    // Bot alerts
    if (snapshot.walletQuality.botRatio > thresholds.highBotRatio) {
      alerts.push({
        level: 'warning',
        type: 'bots',
        message: `High bot ratio: ${(snapshot.walletQuality.botRatio * 100).toFixed(1)}% suspected bots`,
        value: snapshot.walletQuality.botRatio
      });
    }

    // Distribution alerts
    if (snapshot.distribution.giniCoefficient > thresholds.highGini) {
      alerts.push({
        level: 'warning',
        type: 'distribution',
        message: `Poor distribution: Gini coefficient ${snapshot.distribution.giniCoefficient.toFixed(3)}`,
        value: snapshot.distribution.giniCoefficient
      });
    }

    // Risk alerts
    if (snapshot.riskMetrics.overallRisk > thresholds.highRisk) {
      alerts.push({
        level: 'critical',
        type: 'risk',
        message: `High overall risk: ${snapshot.riskMetrics.overallRisk}/100`,
        value: snapshot.riskMetrics.overallRisk
      });
    }

    if (snapshot.riskMetrics.rugPullRisk > 60) {
      alerts.push({
        level: 'critical',
        type: 'rugpull',
        message: `Rug pull risk: ${snapshot.riskMetrics.rugPullRisk}/100`,
        value: snapshot.riskMetrics.rugPullRisk
      });
    }

    // Score alerts
    if (score.total < thresholds.lowScore) {
      alerts.push({
        level: 'warning',
        type: 'score',
        message: `Low holder score: ${score.total}/333`,
        value: score.total
      });
    } else if (score.total > thresholds.highScore) {
      alerts.push({
        level: 'info',
        type: 'score',
        message: `Excellent holder score: ${score.total}/333`,
        value: score.total
      });
    }

    // Positive alerts
    if (snapshot.walletQuality.smartMoneyRatio > 0.1) {
      alerts.push({
        level: 'info',
        type: 'smart_money',
        message: `Smart money present: ${(snapshot.walletQuality.smartMoneyRatio * 100).toFixed(1)}%`,
        value: snapshot.walletQuality.smartMoneyRatio
      });
    }

    if (snapshot.walletQuality.diamondHandRatio > 0.5) {
      alerts.push({
        level: 'info',
        type: 'diamond_hands',
        message: `Strong holders: ${(snapshot.walletQuality.diamondHandRatio * 100).toFixed(1)}% diamond hands`,
        value: snapshot.walletQuality.diamondHandRatio
      });
    }

    return alerts;
  }

  // ============================================
  // Database Queries
  // ============================================

  private async getEligibleTokens(): Promise<TokenToAnalyze[]> {
    const query = `
      WITH token_stats AS (
        SELECT 
          t.id,
          t.mint_address,
          t.symbol,
          t.name,
          t.created_at,
          p.platform,
          p.bonding_curve_progress,
          p.status,
          COUNT(DISTINCT tx.id) as transaction_count,
          MAX(hs.score_time) as last_analyzed
        FROM tokens t
        INNER JOIN pools p ON t.id = p.token_id
        LEFT JOIN transactions tx ON t.id = tx.token_id
        LEFT JOIN holder_scores hs ON t.id = hs.token_id
        WHERE 
          p.bonding_curve_progress >= $1
          AND p.bonding_curve_progress <= $2
          AND p.status = 'active'
          AND t.created_at < NOW() - INTERVAL '1 minute' * $3
        GROUP BY t.id, t.mint_address, t.symbol, t.name, t.created_at, 
                 p.platform, p.bonding_curve_progress, p.status
        HAVING COUNT(DISTINCT tx.id) >= 3
      )
      SELECT 
        id as "tokenId",
        mint_address as "mintAddress",
        symbol,
        name,
        created_at as "createdAt",
        platform,
        bonding_curve_progress as "bondingCurveProgress",
        transaction_count as "transactionCount",
        last_analyzed as "lastAnalyzed"
      FROM token_stats
      WHERE 
        last_analyzed IS NULL 
        OR last_analyzed < NOW() - INTERVAL '5 minutes'
      ORDER BY 
        CASE 
          WHEN bonding_curve_progress BETWEEN 15 AND 25 THEN 0
          WHEN bonding_curve_progress BETWEEN 10 AND 30 THEN 1
          ELSE 2
        END,
        transaction_count DESC
      LIMIT 50
    `;

    const result = await this.db.query(query, [
      this.config.minBondingCurveProgress,
      this.config.maxBondingCurveProgress,
      this.config.minTokenAgeMinutes
    ]);

    return result.rows.map(row => ({
      tokenId: row.tokenId,
      mintAddress: row.mintAddress,
      symbol: row.symbol,
      name: row.name,
      bondingCurveProgress: parseFloat(row.bondingCurveProgress),
      createdAt: new Date(row.createdAt),
      platform: row.platform,
      lastAnalyzed: row.lastAnalyzed ? new Date(row.lastAnalyzed) : undefined,
      transactionCount: parseInt(row.transactionCount)
    }));
  }

  // ============================================
  // WebSocket Updates
  // ============================================

  private async handleHolderUpdate(data: any): Promise<void> {
    console.log(`[HolderMonitor] Holder update for ${data.mintAddress}`);
    
    // Invalidate analysis cache for this token
    this.lastAnalysisTime.delete(data.mintAddress);
    
    // Emit update event
    this.emit('holderUpdate', data);
  }

  // ============================================
  // Credit Tracking
  // ============================================

  private startCreditTracking(): void {
    // Log credits every hour
    setInterval(() => {
      const creditsUsed = this.service.getCreditsUsed();
      const dailyRate = creditsUsed * 24;
      const monthlyRate = dailyRate * 30;
      
      console.log(`[HolderMonitor] API Credits:`);
      console.log(`  - Used this session: ${creditsUsed.toLocaleString()}`);
      console.log(`  - Daily rate: ${dailyRate.toLocaleString()}`);
      console.log(`  - Monthly projection: ${monthlyRate.toLocaleString()}`);
      console.log(`  - Monthly limit: 10,000,000`);
      console.log(`  - Usage: ${((monthlyRate / 10_000_000) * 100).toFixed(2)}%`);

      if (monthlyRate > 8_000_000) {
        console.warn('[HolderMonitor] WARNING: Approaching monthly credit limit!');
        this.emit('creditWarning', {
          used: creditsUsed,
          projected: monthlyRate,
          limit: 10_000_000
        });
      }

    }, 60 * 60 * 1000); // Every hour
  }

  // ============================================
  // Logging
  // ============================================

  private logAnalysisSummary(result: AnalysisResult): void {
    const { token, score, metrics, alerts } = result;
    
    console.log(`[HolderMonitor] Analysis complete for ${token.symbol}:`);
    console.log(`  Score: ${score.total}/333 (D:${score.distribution} Q:${score.quality} A:${score.activity})`);
    console.log(`  Holders: ${metrics.holderCount}`);
    console.log(`  Gini: ${metrics.giniCoefficient.toFixed(3)}`);
    console.log(`  Top10: ${metrics.top10Concentration.toFixed(1)}%`);
    console.log(`  Bots: ${(metrics.botRatio * 100).toFixed(1)}%`);
    console.log(`  Smart Money: ${(metrics.smartMoneyRatio * 100).toFixed(1)}%`);
    console.log(`  Risk: ${metrics.overallRisk}/100`);
    
    if (alerts.length > 0) {
      console.log(`  Alerts (${alerts.length}):`);
      alerts.forEach(alert => {
        const icon = alert.level === 'critical' ? '🚨' : 
                    alert.level === 'warning' ? '⚠️' : 'ℹ️';
        console.log(`    ${icon} ${alert.message}`);
      });
    }
  }

  // ============================================
  // Public API
  // ============================================

  async getLatestScores(limit: number = 20): Promise<any[]> {
    const query = `
      SELECT * FROM latest_holder_scores_v2
      ORDER BY total_score DESC
      LIMIT $1
    `;
    
    const result = await this.db.query(query, [limit]);
    return result.rows;
  }

  async getTokenScore(mintAddress: string): Promise<any> {
    const query = `
      SELECT * FROM latest_holder_scores_v2
      WHERE mint_address = $1
    `;
    
    const result = await this.db.query(query, [mintAddress]);
    return result.rows[0];
  }

  async getSmartMoneyWallets(limit: number = 100): Promise<any[]> {
    const query = `
      SELECT * FROM smart_money_wallets
      LIMIT $1
    `;
    
    const result = await this.db.query(query, [limit]);
    return result.rows;
  }

  getActiveAnalysis(): string[] {
    return Array.from(this.activeAnalysis);
  }

  getCreditsUsed(): number {
    return this.service.getCreditsUsed();
  }

  // ============================================
  // Utilities
  // ============================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================
// Export Functions
// ============================================

export async function startHolderMonitorV2(config: MonitorConfig): Promise<HolderMonitorV2> {
  const monitor = new HolderMonitorV2(config);
  await monitor.start();
  return monitor;
}

export default HolderMonitorV2;