import { Helius } from 'helius-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { getDbPool } from '../../database/connection';
import { MetricsCalculator } from './metrics-calculator';
import { PatternDetector } from './pattern-detector';
import { CreditTracker } from './credit-tracker';

interface Holder {
  address: string;
  balance: number;
  tokenAccount: string;
}

interface WalletData {
  address: string;
  createdAt: Date;
  lastActive: Date;
  transactionCount: number;
  buyCount: number;
  sellCount: number;
  solBalance: number;
  walletAge: number;
  isBot: boolean;
  isSmartMoney: boolean;
  isMevBot?: boolean;
  riskScore: number;
  uniqueTokensTraded?: number;
  totalVolumeUSD?: number;
  totalPnL?: number;
  winRate?: number;
  graduatedTokens?: number;
}

export interface EnrichedHolder extends Holder, WalletData {
  tokenBalance: number;
  firstTransaction?: Date;
  isVerified?: boolean;
  connectedWallets?: string[];
}

export interface AnalysisResult {
  token: {
    mint: string;
    symbol?: string;
    bondingCurveProgress: number;
  };
  metrics: {
    distribution: any;
    quality: any;
    activity: any;
    risk: any;
  };
  score: {
    total: number;
    distribution: number;
    quality: number;
    activity: number;
  };
  alerts: Array<{
    type: 'CRITICAL' | 'WARNING' | 'INFO' | 'POSITIVE';
    message: string;
  }>;
  timestamp: Date;
  apiCreditsUsed: number;
}

class HolderCache {
  private cache = new Map<string, { data: WalletData; timestamp: number }>();
  private ttl: number;

  constructor(ttlMs: number = 300000) {
    this.ttl = ttlMs;
  }

  async partition(holders: Holder[]): Promise<{ cached: EnrichedHolder[]; uncached: string[] }> {
    const now = Date.now();
    const cached: EnrichedHolder[] = [];
    const uncached: string[] = [];

    for (const holder of holders) {
      const cacheEntry = this.cache.get(holder.address);
      
      if (cacheEntry && (now - cacheEntry.timestamp) < this.ttl) {
        cached.push({
          ...holder,
          ...cacheEntry.data,
          tokenBalance: holder.balance
        });
      } else {
        uncached.push(holder.address);
      }
    }

    return { cached, uncached };
  }

  set(address: string, data: WalletData): void {
    this.cache.set(address, {
      data,
      timestamp: Date.now()
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

export class HolderAnalysisService {
  private helius: Helius;
  private connection: Connection;
  private cache: HolderCache;
  private creditTracker: CreditTracker;
  private metricsCalculator: MetricsCalculator;
  private patternDetector: PatternDetector;
  private dbPool: any;

  constructor() {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      throw new Error('HELIUS_API_KEY environment variable is required');
    }

    this.helius = new Helius(apiKey);
    this.connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`);
    this.cache = new HolderCache(300000); // 5 minute TTL
    this.creditTracker = new CreditTracker(10_000_000); // 10M monthly limit
    this.metricsCalculator = new MetricsCalculator();
    this.patternDetector = new PatternDetector();
    this.dbPool = getDbPool();
  }

  async analyzeToken(mint: string, bondingCurveProgress: number): Promise<AnalysisResult | null> {
    const startTime = Date.now();
    let totalCredits = 0;

    try {
      // Check if we should analyze this token
      if (!this.shouldAnalyze(bondingCurveProgress)) {
        return null;
      }

      // Stage 1: Get holder list (1 credit per 1000 holders)
      console.log(`📊 Fetching holders for ${mint}...`);
      const holders = await this.fetchHoldersList(mint);
      totalCredits += Math.ceil(holders.length / 1000);

      if (holders.length < 5) {
        console.log(`Insufficient holders (${holders.length}), skipping analysis`);
        return null;
      }

      // Stage 2: Check cache for existing wallet data
      const { cached, uncached } = await this.cache.partition(holders);
      console.log(`✅ Cache hit: ${cached.length}/${holders.length} wallets`);

      // Stage 3: Batch fetch uncached wallets (2 credits each)
      let newWalletData: EnrichedHolder[] = [];
      if (uncached.length > 0) {
        console.log(`🔄 Enriching ${uncached.length} new wallets...`);
        const walletData = await this.batchEnrichWallets(uncached);
        totalCredits += uncached.length * 2;

        // Combine with holder balance data
        newWalletData = walletData.map(w => {
          const holder = holders.find(h => h.address === w.address);
          return {
            ...w,
            ...holder!,
            tokenBalance: holder?.balance || 0
          } as EnrichedHolder;
        });

        // Update cache
        walletData.forEach(w => this.cache.set(w.address, w));
      }

      // Stage 4: Calculate all metrics
      const allHolders = [...cached, ...newWalletData];
      const metrics = await this.calculateAllMetrics(allHolders, mint);

      // Stage 5: Calculate scores
      const score = this.calculateScore(metrics);

      // Stage 6: Generate alerts
      const alerts = this.generateAlerts(metrics, score);

      // Stage 7: Save to database
      await this.saveSnapshot(mint, metrics, score, totalCredits);

      const processingTime = Date.now() - startTime;
      console.log(`✅ Analysis complete in ${processingTime}ms using ${totalCredits} credits`);

      return {
        token: {
          mint,
          bondingCurveProgress
        },
        metrics,
        score,
        alerts,
        timestamp: new Date(),
        apiCreditsUsed: totalCredits
      };

    } catch (error) {
      console.error(`Error analyzing token ${mint}:`, error);
      return null;
    }
  }

  private shouldAnalyze(progress: number): boolean {
    // Analyze tokens between 10-50% progress
    return progress >= 10 && progress <= 50;
  }

  private async fetchHoldersList(mint: string): Promise<Holder[]> {
    const holders: Holder[] = [];
    let page = 1;
    const limit = 1000;

    while (true) {
      try {
        const response = await this.helius.rpc.getTokenAccounts({
          mint,
          limit,
          page
        });

        this.creditTracker.increment(1, 'getTokenAccounts');

        if (!response?.token_accounts || response.token_accounts.length === 0) {
          break;
        }

        // Add holders with positive balance
        response.token_accounts.forEach((account: any) => {
          const balance = parseInt(account.amount) / 1e6;
          if (balance > 0) {
            holders.push({
              address: account.owner,
              balance,
              tokenAccount: account.address
            });
          }
        });

        if (response.token_accounts.length < limit) {
          break;
        }

        page++;
        await this.sleep(50); // Rate limiting

      } catch (error) {
        console.error(`Error fetching holders page ${page}:`, error);
        break;
      }
    }

    return holders;
  }

  private async batchEnrichWallets(wallets: string[]): Promise<WalletData[]> {
    const BATCH_SIZE = 25;
    const enriched: WalletData[] = [];

    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
      const batch = wallets.slice(i, i + BATCH_SIZE);

      // Parallel enrichment with error handling
      const batchPromises = batch.map((wallet, index) => 
        this.enrichSingleWallet(wallet, index * 20) // Stagger requests
      );

      const batchResults = await Promise.allSettled(batchPromises);

      enriched.push(...batchResults
        .filter(r => r.status === 'fulfilled')
        .map(r => (r as PromiseFulfilledResult<WalletData>).value)
      );

      // Rate limit between batches
      if (i + BATCH_SIZE < wallets.length) {
        await this.sleep(100);
      }
    }

    return enriched;
  }

  private async enrichSingleWallet(address: string, delay: number = 0): Promise<WalletData> {
    if (delay > 0) {
      await this.sleep(delay);
    }

    try {
      // Get transaction signatures
      const signatures = await this.helius.rpc.getSignaturesForAddress({
        address,
        limit: 100 // Reduced from 1000 to save credits
      });

      this.creditTracker.increment(2, 'getSignaturesForAddress');

      if (!signatures || signatures.length === 0) {
        return this.getDefaultWalletData(address);
      }

      // Get oldest and newest transactions
      const oldestTx = signatures[signatures.length - 1];
      const newestTx = signatures[0];

      // Calculate wallet age
      const createdAt = new Date(oldestTx.blockTime * 1000);
      const lastActive = new Date(newestTx.blockTime * 1000);
      const walletAge = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

      // Get SOL balance
      const balance = await this.connection.getBalance(new PublicKey(address));

      // Analyze transaction patterns
      const buyCount = signatures.filter((s: any) => 
        s.memo?.toLowerCase().includes('buy') || 
        s.confirmationStatus === 'finalized'
      ).length;
      
      const sellCount = signatures.filter((s: any) => 
        s.memo?.toLowerCase().includes('sell')
      ).length;

      // Detect bot and smart money patterns
      const isBot = this.patternDetector.detectBot({
        address,
        createdAt,
        lastActive,
        transactionCount: signatures.length,
        buyCount,
        sellCount,
        solBalance: balance / 1e9,
        walletAge,
        signatures
      });

      const isSmartMoney = this.patternDetector.detectSmartMoney({
        address,
        walletAge,
        transactionCount: signatures.length,
        solBalance: balance / 1e9,
        signatures
      });

      const riskScore = this.patternDetector.calculateWalletRisk({
        address,
        walletAge,
        isBot,
        solBalance: balance / 1e9,
        transactionCount: signatures.length
      });

      return {
        address,
        createdAt,
        lastActive,
        transactionCount: signatures.length,
        buyCount,
        sellCount,
        solBalance: balance / 1e9,
        walletAge,
        isBot,
        isSmartMoney,
        riskScore
      };

    } catch (error) {
      console.error(`Error enriching wallet ${address}:`, error);
      return this.getDefaultWalletData(address);
    }
  }

  private getDefaultWalletData(address: string): WalletData {
    return {
      address,
      createdAt: new Date(),
      lastActive: new Date(),
      transactionCount: 0,
      buyCount: 0,
      sellCount: 0,
      solBalance: 0,
      walletAge: 0,
      isBot: false,
      isSmartMoney: false,
      riskScore: 50
    };
  }

  private async calculateAllMetrics(holders: EnrichedHolder[], mint: string) {
    const distribution = this.metricsCalculator.calculateDistributionMetrics(holders);
    const quality = this.metricsCalculator.calculateQualityMetrics(holders);
    const activity = this.metricsCalculator.calculateActivityMetrics(holders);
    const risk = this.metricsCalculator.calculateRiskMetrics(holders, distribution);

    return {
      distribution,
      quality,
      activity,
      risk
    };
  }

  private calculateScore(metrics: any): any {
    // Distribution score (111 points)
    let distributionScore = 0;
    
    // Gini coefficient (40 points)
    if (metrics.distribution.giniCoefficient < 0.3) distributionScore += 40;
    else if (metrics.distribution.giniCoefficient < 0.5) distributionScore += 30;
    else if (metrics.distribution.giniCoefficient < 0.7) distributionScore += 20;
    else if (metrics.distribution.giniCoefficient < 0.8) distributionScore += 10;
    
    // Concentration (40 points)
    if (metrics.distribution.top1Percent < 5) distributionScore += 40;
    else if (metrics.distribution.top1Percent < 10) distributionScore += 30;
    else if (metrics.distribution.top1Percent < 15) distributionScore += 20;
    else if (metrics.distribution.top1Percent < 20) distributionScore += 10;
    
    // Holder count (31 points)
    const holderPoints = Math.min(31, Math.floor(metrics.distribution.uniqueHolders / 10));
    distributionScore += holderPoints;

    // Quality score (111 points)
    let qualityScore = 0;
    
    // Bot ratio (40 points)
    if (metrics.quality.botRatio < 0.1) qualityScore += 40;
    else if (metrics.quality.botRatio < 0.2) qualityScore += 30;
    else if (metrics.quality.botRatio < 0.3) qualityScore += 20;
    else if (metrics.quality.botRatio < 0.4) qualityScore += 10;
    
    // Smart money (40 points)
    qualityScore += Math.min(40, metrics.quality.smartMoneyRatio * 400);
    
    // Wallet age (31 points)
    if (metrics.quality.averageWalletAge > 90) qualityScore += 31;
    else if (metrics.quality.averageWalletAge > 60) qualityScore += 25;
    else if (metrics.quality.averageWalletAge > 30) qualityScore += 20;
    else if (metrics.quality.averageWalletAge > 14) qualityScore += 15;
    else if (metrics.quality.averageWalletAge > 7) qualityScore += 10;

    // Activity score (111 points)
    let activityScore = 0;
    
    // Active holders (40 points)
    const activeRatio = metrics.activity.activeHolders24h / metrics.distribution.uniqueHolders;
    activityScore += Math.min(40, activeRatio * 50);
    
    // Organic growth (40 points)
    activityScore += Math.min(40, metrics.activity.organicGrowthScore * 40);
    
    // Velocity (31 points)
    activityScore += Math.min(31, metrics.activity.velocityScore * 31);

    return {
      total: distributionScore + qualityScore + activityScore,
      distribution: distributionScore,
      quality: qualityScore,
      activity: activityScore
    };
  }

  private generateAlerts(metrics: any, score: any): any[] {
    const alerts = [];

    // Critical alerts
    if (metrics.distribution.giniCoefficient > 0.9) {
      alerts.push({
        type: 'CRITICAL',
        message: `Extreme concentration: Gini ${metrics.distribution.giniCoefficient.toFixed(3)}`
      });
    }

    if (metrics.quality.botRatio > 0.5) {
      alerts.push({
        type: 'CRITICAL',
        message: `Bot swarm detected: ${(metrics.quality.botRatio * 100).toFixed(1)}% bots`
      });
    }

    if (metrics.risk.overall > 80) {
      alerts.push({
        type: 'CRITICAL',
        message: `High risk score: ${metrics.risk.overall}/100`
      });
    }

    // Warning alerts
    if (metrics.distribution.top1Percent > 20) {
      alerts.push({
        type: 'WARNING',
        message: `Top holder owns ${metrics.distribution.top1Percent.toFixed(1)}%`
      });
    }

    if (metrics.quality.averageWalletAge < 7) {
      alerts.push({
        type: 'WARNING',
        message: `New wallets: avg age ${metrics.quality.averageWalletAge.toFixed(1)} days`
      });
    }

    // Positive alerts
    if (metrics.quality.smartMoneyRatio > 0.1) {
      alerts.push({
        type: 'POSITIVE',
        message: `Smart money present: ${(metrics.quality.smartMoneyRatio * 100).toFixed(1)}%`
      });
    }

    if (score.total > 250) {
      alerts.push({
        type: 'POSITIVE',
        message: `Strong holder base: ${score.total}/333`
      });
    }

    return alerts;
  }

  private async saveSnapshot(mint: string, metrics: any, score: any, creditsUsed: number) {
    try {
      // Get token ID
      const tokenResult = await this.dbPool.query(
        'SELECT id FROM tokens WHERE mint_address = $1',
        [mint]
      );

      if (tokenResult.rows.length === 0) {
        console.warn(`Token ${mint} not found in database`);
        return;
      }

      const tokenId = tokenResult.rows[0].id;

      // Save holder snapshot
      await this.dbPool.query(`
        INSERT INTO holder_snapshots_v2 (
          token_id, unique_holders, gini_coefficient, herfindahl_index,
          top_1_percent, top_10_percent, bot_count, bot_ratio,
          smart_money_count, smart_money_ratio, avg_wallet_age_days,
          active_holders_24h, new_holders_24h, velocity_score,
          organic_growth_score, overall_risk, api_credits_used
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `, [
        tokenId,
        metrics.distribution.uniqueHolders,
        metrics.distribution.giniCoefficient,
        metrics.distribution.herfindahlIndex,
        metrics.distribution.top1Percent,
        metrics.distribution.top10Percent,
        metrics.quality.botCount || 0,
        metrics.quality.botRatio,
        metrics.quality.smartMoneyCount || 0,
        metrics.quality.smartMoneyRatio,
        metrics.quality.averageWalletAge,
        metrics.activity.activeHolders24h,
        metrics.activity.newHolders24h,
        metrics.activity.velocityScore,
        metrics.activity.organicGrowthScore,
        metrics.risk.overall,
        creditsUsed
      ]);

      // Save holder score
      await this.dbPool.query(`
        INSERT INTO holder_scores_v2 (
          token_id, total_score, distribution_score, quality_score,
          activity_score, unique_holders, gini_coefficient,
          bot_ratio, smart_money_ratio, overall_risk
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        tokenId,
        score.total,
        score.distribution,
        score.quality,
        score.activity,
        metrics.distribution.uniqueHolders,
        metrics.distribution.giniCoefficient,
        metrics.quality.botRatio,
        metrics.quality.smartMoneyRatio,
        metrics.risk.overall
      ]);

    } catch (error) {
      console.error('Error saving snapshot:', error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getApiUsageStats() {
    return this.creditTracker.getStats();
  }
}