import { Helius } from 'helius-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { getDbPool } from '../../database/connection';
import { MetricsCalculator } from './metrics-calculator';
import { PatternDetector } from './pattern-detector';
import { ScoringConfigLoader, HolderScoringConfig, getEnvironmentOverrides } from '../../config/holder-scoring-config';

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

export interface QuickScoreResult {
  token: string;
  score: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  shouldDeepAnalyze: boolean;
  metrics: {
    uniqueBuyers: number;
    largestBuy: number;
    buyRatio: number;
  };
  processingTime: number;
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

export class HolderAnalysisServiceV3 {
  private helius: Helius;
  private connection: Connection;
  private cache: HolderCache;
  private metricsCalculator: MetricsCalculator;
  private patternDetector: PatternDetector;
  private dbPool: any;
  private configLoader: ScoringConfigLoader;
  private config: HolderScoringConfig;
  
  // Known system addresses to exclude from holder analysis
  private readonly SYSTEM_ADDRESSES = new Set([
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Pump.fun bonding curve
    '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', // Pump.fun fee account
    'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', // Pump.fun program
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun program ID
    'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1', // Pump.fun migration vault
  ]);

  constructor() {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      throw new Error('HELIUS_API_KEY environment variable is required');
    }

    this.helius = new Helius(apiKey);
    this.connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`);
    this.cache = new HolderCache(300000); // 5 minute TTL
    this.metricsCalculator = new MetricsCalculator();
    this.patternDetector = new PatternDetector();
    this.dbPool = getDbPool();
    
    // Load configuration
    this.configLoader = ScoringConfigLoader.getInstance();
    this.configLoader.override(getEnvironmentOverrides());
    this.config = this.configLoader.getConfig();
  }

  async analyzeToken(mint: string, bondingCurveProgress: number): Promise<AnalysisResult | null> {
    const startTime = Date.now();
    let totalCredits = 0;

    try {
      // Check if we should analyze this token
      if (!this.shouldAnalyze(bondingCurveProgress)) {
        return null;
      }

      // Get bonding curve address for this token
      const bondingCurveAddress = await this.getBondingCurveAddress(mint);

      // Stage 1: Get holder list
      console.log(`📊 Fetching holders for ${mint}...`);
      const holders = await this.fetchHoldersList(mint, bondingCurveAddress);
      totalCredits += Math.ceil(holders.length / 1000);

      if (holders.length < 5) {
        console.log(`Insufficient holders (${holders.length}), skipping analysis`);
        return null;
      }

      // Stage 2: Check cache for existing wallet data
      const { cached, uncached } = await this.cache.partition(holders);
      console.log(`✅ Cache hit: ${cached.length}/${holders.length} wallets`);

      // Stage 3: Batch fetch uncached wallets
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

      // Stage 5: Calculate scores using config
      const score = this.calculateScore(metrics);

      // Stage 6: Generate alerts using config
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

  /**
   * Quick score calculation using only database data (no API calls)
   * Returns a score 0-50 for rapid decision making
   */
  async getQuickScore(mint: string): Promise<QuickScoreResult | null> {
    const startTime = Date.now();
    const config = this.config.quickScore;

    try {
      // Try to get from recent cache first
      const cached = await this.dbPool.query(`
        SELECT hs.total_score, hs.score_time as snapshot_time 
        FROM holder_scores_v2 hs
        WHERE hs.token_id = (SELECT id FROM tokens WHERE mint_address = $1)
        AND hs.score_time > NOW() - INTERVAL '5 minutes'
        ORDER BY hs.score_time DESC
        LIMIT 1
      `, [mint]);
      
      if (cached.rows.length > 0) {
        return {
          token: mint,
          score: cached.rows[0].total_score,
          confidence: 'HIGH',
          shouldDeepAnalyze: false,
          metrics: { uniqueBuyers: 0, largestBuy: 0, buyRatio: 0 },
          processingTime: Date.now() - startTime
        };
      }
      
      // Get basic metrics from database (no API)
      const metrics = await this.dbPool.query(`
        SELECT 
          COUNT(DISTINCT tx.user_address) FILTER (WHERE tx.type = 'buy') as unique_buyers,
          MAX(tx.sol_amount) FILTER (WHERE tx.type = 'buy') as largest_buy,
          COUNT(*) FILTER (WHERE tx.type = 'buy') as buy_count,
          COUNT(*) FILTER (WHERE tx.type = 'sell') as sell_count
        FROM transactions tx
        JOIN tokens t ON tx.token_id = t.id
        WHERE t.mint_address = $1
        AND tx.block_time > NOW() - INTERVAL '1 hour'
      `, [mint]);
      
      const row = metrics.rows[0];
      if (!row) {
        return null;
      }

      let score = 0;
      
      // Score unique buyers
      if (row.unique_buyers >= config.uniqueBuyers.high) {
        score += config.uniqueBuyers.points.high;
      } else if (row.unique_buyers >= config.uniqueBuyers.medium) {
        score += config.uniqueBuyers.points.medium;
      } else if (row.unique_buyers >= config.uniqueBuyers.low) {
        score += config.uniqueBuyers.points.low;
      }
      
      // Score largest buy
      if (row.largest_buy >= config.largestBuy.high) {
        score += config.largestBuy.points.high;
      } else if (row.largest_buy >= config.largestBuy.medium) {
        score += config.largestBuy.points.medium;
      } else if (row.largest_buy >= config.largestBuy.low) {
        score += config.largestBuy.points.low;
      }
      
      // Score buy/sell ratio
      const ratio = row.buy_count / (row.sell_count || 1);
      if (ratio >= config.buyRatio.high) {
        score += config.buyRatio.points.high;
      } else if (ratio >= config.buyRatio.medium) {
        score += config.buyRatio.points.medium;
      } else if (ratio >= config.buyRatio.low) {
        score += config.buyRatio.points.low;
      }

      const processingTime = Date.now() - startTime;
      
      return {
        token: mint,
        score,
        confidence: row.unique_buyers > 5 ? 'MEDIUM' : 'LOW',
        shouldDeepAnalyze: score > 35 || row.largest_buy > 3,
        metrics: {
          uniqueBuyers: row.unique_buyers,
          largestBuy: row.largest_buy,
          buyRatio: ratio
        },
        processingTime
      };
    } catch (error) {
      console.error('Quick score error:', error);
      return null;
    }
  }

  private shouldAnalyze(progress: number): boolean {
    // Analyze tokens between 10-50% progress
    return progress >= 10 && progress <= 50;
  }

  private async getBondingCurveAddress(mint: string): Promise<string | null> {
    try {
      const result = await this.dbPool.query(`
        SELECT p.bonding_curve_address 
        FROM pools p
        JOIN tokens t ON p.token_id = t.id
        WHERE t.mint_address = $1
        LIMIT 1
      `, [mint]);
      
      return result.rows[0]?.bonding_curve_address || null;
    } catch (error) {
      console.error('Error fetching bonding curve address:', error);
      return null;
    }
  }

  private async fetchHoldersList(mint: string, bondingCurveAddress: string | null): Promise<Holder[]> {
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

        if (!response?.token_accounts || response.token_accounts.length === 0) {
          break;
        }

        // Add holders with positive balance (excluding system addresses)
        response.token_accounts.forEach((account: any) => {
          const balance = parseInt(account.amount) / 1e6;
          
          if (balance > 0 && !this.SYSTEM_ADDRESSES.has(account.owner) && account.owner !== bondingCurveAddress) {
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
        await this.sleep(50);

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

      const batchPromises = batch.map((wallet, index) => 
        this.enrichSingleWallet(wallet, index * 20)
      );

      const batchResults = await Promise.allSettled(batchPromises);

      enriched.push(...batchResults
        .filter(r => r.status === 'fulfilled')
        .map(r => (r as PromiseFulfilledResult<WalletData>).value)
      );

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
      const pubkey = new PublicKey(address);
      const signatures = await this.connection.getSignaturesForAddress(
        pubkey,
        { limit: 100 }
      );

      if (!signatures || signatures.length === 0) {
        return this.getDefaultWalletData(address);
      }

      const oldestTx = signatures[signatures.length - 1];
      const newestTx = signatures[0];

      const createdAt = oldestTx.blockTime ? new Date(oldestTx.blockTime * 1000) : new Date();
      const lastActive = newestTx.blockTime ? new Date(newestTx.blockTime * 1000) : new Date();
      const walletAge = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

      const balance = await this.connection.getBalance(new PublicKey(address));

      const buyCount = signatures.filter((s: any) => 
        s.memo?.toLowerCase().includes('buy') || 
        s.confirmationStatus === 'finalized'
      ).length;
      
      const sellCount = signatures.filter((s: any) => 
        s.memo?.toLowerCase().includes('sell')
      ).length;

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
    // Reload config in case it changed
    this.config = this.configLoader.getConfig();
    const config = this.config;

    // Distribution score (111 points)
    let distributionScore = 0;
    
    // Gini coefficient (40 points) - using config
    const gini = metrics.distribution.giniCoefficient;
    if (gini < config.distribution.gini.excellent) {
      distributionScore += config.distribution.gini.points.excellent;
    } else if (gini < config.distribution.gini.good) {
      distributionScore += config.distribution.gini.points.good;
    } else if (gini < config.distribution.gini.fair) {
      distributionScore += config.distribution.gini.points.fair;
    } else if (gini < config.distribution.gini.poor) {
      distributionScore += config.distribution.gini.points.poor;
    }
    
    // Concentration (40 points) - using config
    const top1 = metrics.distribution.top1Percent;
    if (top1 < config.distribution.top1Percent.excellent) {
      distributionScore += config.distribution.top1Percent.points.excellent;
    } else if (top1 < config.distribution.top1Percent.good) {
      distributionScore += config.distribution.top1Percent.points.good;
    } else if (top1 < config.distribution.top1Percent.fair) {
      distributionScore += config.distribution.top1Percent.points.fair;
    } else if (top1 < config.distribution.top1Percent.poor) {
      distributionScore += config.distribution.top1Percent.points.poor;
    }
    
    // Holder count (31 points) - using config
    const holderPoints = Math.min(
      config.distribution.holderCount.maxPoints, 
      Math.floor(metrics.distribution.uniqueHolders / config.distribution.holderCount.divisor)
    );
    distributionScore += holderPoints;

    // Quality score (111 points)
    let qualityScore = 0;
    
    // Bot ratio (40 points) - using config
    const botRatio = metrics.quality.botRatio;
    if (botRatio < config.quality.botRatio.excellent) {
      qualityScore += config.quality.botRatio.points.excellent;
    } else if (botRatio < config.quality.botRatio.good) {
      qualityScore += config.quality.botRatio.points.good;
    } else if (botRatio < config.quality.botRatio.fair) {
      qualityScore += config.quality.botRatio.points.fair;
    } else if (botRatio < config.quality.botRatio.poor) {
      qualityScore += config.quality.botRatio.points.poor;
    }
    
    // Smart money (40 points) - using config
    qualityScore += Math.min(
      config.quality.smartMoney.maxPoints, 
      metrics.quality.smartMoneyRatio * config.quality.smartMoney.multiplier
    );
    
    // Wallet age (31 points) - using config
    const avgAge = metrics.quality.averageWalletAge;
    if (avgAge > config.quality.walletAge.excellent) {
      qualityScore += config.quality.walletAge.points.excellent;
    } else if (avgAge > config.quality.walletAge.good) {
      qualityScore += config.quality.walletAge.points.good;
    } else if (avgAge > config.quality.walletAge.fair) {
      qualityScore += config.quality.walletAge.points.fair;
    } else if (avgAge > config.quality.walletAge.acceptable) {
      qualityScore += config.quality.walletAge.points.acceptable;
    } else if (avgAge > config.quality.walletAge.poor) {
      qualityScore += config.quality.walletAge.points.poor;
    }

    // Activity score (111 points)
    let activityScore = 0;
    
    // Active holders (40 points) - using config
    const activeRatio = metrics.activity.activeHolders24h / metrics.distribution.uniqueHolders;
    activityScore += Math.min(
      config.activity.activeHolders.maxPoints, 
      activeRatio * config.activity.activeHolders.multiplier
    );
    
    // Organic growth (40 points) - using config
    activityScore += Math.min(
      config.activity.organicGrowth.maxPoints, 
      metrics.activity.organicGrowthScore * config.activity.organicGrowth.multiplier
    );
    
    // Velocity (31 points) - using config
    activityScore += Math.min(
      config.activity.velocity.maxPoints, 
      metrics.activity.velocityScore * config.activity.velocity.multiplier
    );

    return {
      total: distributionScore + qualityScore + activityScore,
      distribution: distributionScore,
      quality: qualityScore,
      activity: activityScore
    };
  }

  private generateAlerts(metrics: any, score: any): any[] {
    const alerts = [];
    const config = this.config.alerts;

    // Critical alerts
    if (metrics.distribution.giniCoefficient > config.critical.giniThreshold) {
      alerts.push({
        type: 'CRITICAL',
        message: `Extreme concentration: Gini ${metrics.distribution.giniCoefficient.toFixed(3)}`
      });
    }

    if (metrics.quality.botRatio > config.critical.botRatioThreshold) {
      alerts.push({
        type: 'CRITICAL',
        message: `Bot swarm detected: ${(metrics.quality.botRatio * 100).toFixed(1)}% bots`
      });
    }

    if (metrics.risk.overall > config.critical.riskScoreThreshold) {
      alerts.push({
        type: 'CRITICAL',
        message: `High risk score: ${metrics.risk.overall}/100`
      });
    }

    // Warning alerts
    if (metrics.distribution.top1Percent > config.warning.topHolderThreshold) {
      alerts.push({
        type: 'WARNING',
        message: `Top holder owns ${metrics.distribution.top1Percent.toFixed(1)}%`
      });
    }

    if (metrics.quality.averageWalletAge < config.warning.walletAgeThreshold) {
      alerts.push({
        type: 'WARNING',
        message: `New wallets: avg age ${metrics.quality.averageWalletAge.toFixed(1)} days`
      });
    }

    // Positive alerts
    if (metrics.quality.smartMoneyRatio > config.positive.smartMoneyThreshold) {
      alerts.push({
        type: 'POSITIVE',
        message: `Smart money present: ${(metrics.quality.smartMoneyRatio * 100).toFixed(1)}%`
      });
    }

    if (score.total > config.positive.totalScoreThreshold) {
      alerts.push({
        type: 'POSITIVE',
        message: `Strong holder base: ${score.total}/333`
      });
    }

    return alerts;
  }

  private async saveSnapshot(mint: string, metrics: any, score: any, creditsUsed: number) {
    try {
      const tokenResult = await this.dbPool.query(
        'SELECT id FROM tokens WHERE mint_address = $1',
        [mint]
      );

      if (tokenResult.rows.length === 0) {
        console.warn(`Token ${mint} not found in database`);
        return;
      }

      const tokenId = tokenResult.rows[0].id;

      await this.dbPool.query(`
        INSERT INTO holder_snapshots_v2 (
          token_id, unique_holders, gini_coefficient, herfindahl_index,
          top_1_percent, top_10_percent, top_100_holders, bot_count, bot_ratio,
          smart_money_count, smart_money_ratio, avg_wallet_age_days,
          active_holders_24h, new_holders_24h, velocity_score,
          organic_growth_score, overall_risk, api_credits_used
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      `, [
        tokenId,
        metrics.distribution.uniqueHolders,
        metrics.distribution.giniCoefficient,
        metrics.distribution.herfindahlIndex,
        metrics.distribution.top1Percent,
        metrics.distribution.top10Percent,
        100.0,
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
}