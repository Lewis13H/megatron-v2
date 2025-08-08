import { Helius } from 'helius-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { getDbPool } from '../../database/connection';
import { MetricsCalculator } from './metrics-calculator';
import { PatternDetector } from './pattern-detector';
import { CreditTracker } from './credit-tracker';
import { RateLimiter } from './rate-limiter';

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
  cacheHitRate: number;
  processingTimeMs: number;
}

// Tiered cache with different TTLs based on wallet type
class TieredHolderCache {
  private tiers = {
    hot: new Map<string, { data: WalletData; timestamp: number }>(),      // 5 min TTL - frequently changing wallets
    warm: new Map<string, { data: WalletData; timestamp: number }>(),     // 30 min TTL - stable wallets
    cold: new Map<string, { data: WalletData; timestamp: number }>(),     // 2 hour TTL - inactive wallets
    permanent: new Map<string, { data: WalletData; timestamp: number }>() // 24 hour TTL - known bots/smart money
  };
  
  private ttls = {
    hot: 300000,        // 5 minutes
    warm: 1800000,      // 30 minutes
    cold: 7200000,      // 2 hours
    permanent: 86400000 // 24 hours
  };
  
  private dbPool: any;
  private cacheStats = {
    hits: 0,
    misses: 0,
    dbLoads: 0
  };

  constructor(dbPool: any) {
    this.dbPool = dbPool;
    this.loadPermanentCache();
  }

  async loadPermanentCache() {
    try {
      // Load known bots and smart money wallets from DB
      const result = await this.dbPool.query(`
        SELECT * FROM wallet_analysis_v2
        WHERE (is_bot = true OR is_smart_money = true)
          AND last_analyzed > NOW() - INTERVAL '24 hours'
        LIMIT 10000
      `);
      
      for (const row of result.rows) {
        const walletData = this.rowToWalletData(row);
        this.permanent.set(row.wallet_address, {
          data: walletData,
          timestamp: Date.now()
        });
      }
      
      console.log(`📦 Loaded ${result.rows.length} permanent cache entries`);
    } catch (error) {
      console.error('Error loading permanent cache:', error);
    }
  }

  private rowToWalletData(row: any): WalletData {
    return {
      address: row.wallet_address,
      createdAt: row.created_at,
      lastActive: row.last_active,
      transactionCount: row.transaction_count,
      buyCount: row.buy_count,
      sellCount: row.sell_count,
      solBalance: parseFloat(row.sol_balance),
      walletAge: row.wallet_age_days,
      isBot: row.is_bot,
      isSmartMoney: row.is_smart_money,
      isMevBot: row.is_mev_bot,
      riskScore: row.risk_score,
      uniqueTokensTraded: row.unique_tokens_traded,
      totalVolumeUSD: parseFloat(row.total_volume_usd),
      totalPnL: parseFloat(row.total_pnl_usd),
      winRate: parseFloat(row.win_rate),
      graduatedTokens: row.graduated_tokens
    };
  }

  async get(address: string): Promise<WalletData | null> {
    const now = Date.now();
    
    // Check each tier in order
    for (const [tierName, tier] of Object.entries(this.tiers)) {
      const entry = tier.get(address);
      if (entry && (now - entry.timestamp) < this.ttls[tierName as keyof typeof this.ttls]) {
        this.cacheStats.hits++;
        
        // Promote to hotter tier if accessed frequently
        if (tierName !== 'hot' && tierName !== 'permanent') {
          this.promote(address, entry.data);
        }
        
        return entry.data;
      }
    }
    
    // Try to load from database
    const dbData = await this.loadFromDatabase(address);
    if (dbData) {
      this.cacheStats.dbLoads++;
      this.set(address, dbData);
      return dbData;
    }
    
    this.cacheStats.misses++;
    return null;
  }

  async loadFromDatabase(address: string): Promise<WalletData | null> {
    try {
      const result = await this.dbPool.query(
        'SELECT * FROM wallet_analysis_v2 WHERE wallet_address = $1',
        [address]
      );
      
      if (result.rows.length > 0) {
        return this.rowToWalletData(result.rows[0]);
      }
    } catch (error) {
      console.error(`Error loading wallet ${address} from DB:`, error);
    }
    
    return null;
  }

  set(address: string, data: WalletData): void {
    const now = Date.now();
    
    // Determine appropriate tier
    let tier: keyof typeof this.tiers;
    
    if (data.isBot || data.isSmartMoney) {
      tier = 'permanent';
    } else if (data.lastActive.getTime() > now - 3600000) { // Active in last hour
      tier = 'hot';
    } else if (data.lastActive.getTime() > now - 86400000) { // Active in last day
      tier = 'warm';
    } else {
      tier = 'cold';
    }
    
    this.tiers[tier].set(address, { data, timestamp: now });
    
    // Evict from other tiers
    for (const [tierName, tierMap] of Object.entries(this.tiers)) {
      if (tierName !== tier) {
        tierMap.delete(address);
      }
    }
    
    // Save to database for persistence
    this.saveToDatabase(address, data);
  }

  private promote(address: string, data: WalletData): void {
    // Move to hot tier for frequently accessed items
    this.tiers.hot.set(address, { data, timestamp: Date.now() });
    
    // Remove from other non-permanent tiers
    this.tiers.warm.delete(address);
    this.tiers.cold.delete(address);
  }

  private async saveToDatabase(address: string, data: WalletData): Promise<void> {
    try {
      await this.dbPool.query(`
        INSERT INTO wallet_analysis_v2 (
          wallet_address, created_at, last_active, transaction_count,
          buy_count, sell_count, unique_tokens_traded, total_volume_usd,
          total_pnl_usd, win_rate, graduated_tokens, sol_balance,
          wallet_age_days, is_bot, is_smart_money, is_mev_bot,
          risk_score, last_analyzed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
        ON CONFLICT (wallet_address) DO UPDATE SET
          last_active = EXCLUDED.last_active,
          transaction_count = EXCLUDED.transaction_count,
          buy_count = EXCLUDED.buy_count,
          sell_count = EXCLUDED.sell_count,
          unique_tokens_traded = EXCLUDED.unique_tokens_traded,
          total_volume_usd = EXCLUDED.total_volume_usd,
          total_pnl_usd = EXCLUDED.total_pnl_usd,
          win_rate = EXCLUDED.win_rate,
          graduated_tokens = EXCLUDED.graduated_tokens,
          sol_balance = EXCLUDED.sol_balance,
          wallet_age_days = EXCLUDED.wallet_age_days,
          is_bot = EXCLUDED.is_bot,
          is_smart_money = EXCLUDED.is_smart_money,
          is_mev_bot = EXCLUDED.is_mev_bot,
          risk_score = EXCLUDED.risk_score,
          last_analyzed = NOW(),
          analysis_count = wallet_analysis_v2.analysis_count + 1
      `, [
        address,
        data.createdAt,
        data.lastActive,
        data.transactionCount,
        data.buyCount,
        data.sellCount,
        data.uniqueTokensTraded || 0,
        data.totalVolumeUSD || 0,
        data.totalPnL || 0,
        data.winRate || 0,
        data.graduatedTokens || 0,
        data.solBalance,
        data.walletAge,
        data.isBot,
        data.isSmartMoney,
        data.isMevBot || false,
        data.riskScore
      ]);
    } catch (error) {
      console.error(`Error saving wallet ${address} to DB:`, error);
    }
  }

  async partition(holders: Holder[]): Promise<{ cached: EnrichedHolder[]; uncached: string[] }> {
    const cached: EnrichedHolder[] = [];
    const uncached: string[] = [];
    
    // Batch check for efficiency
    const cachePromises = holders.map(async (holder) => {
      const cachedData = await this.get(holder.address);
      if (cachedData) {
        return { holder, data: cachedData, cached: true };
      }
      return { holder, data: null, cached: false };
    });
    
    const results = await Promise.all(cachePromises);
    
    for (const result of results) {
      if (result.cached && result.data) {
        cached.push({
          ...result.holder,
          ...result.data,
          tokenBalance: result.holder.balance
        });
      } else {
        uncached.push(result.holder.address);
      }
    }
    
    return { cached, uncached };
  }

  getStats() {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    return {
      ...this.cacheStats,
      hitRate: total > 0 ? this.cacheStats.hits / total : 0,
      sizes: {
        hot: this.tiers.hot.size,
        warm: this.tiers.warm.size,
        cold: this.tiers.cold.size,
        permanent: this.tiers.permanent.size
      }
    };
  }

  // Periodic cleanup of expired entries
  cleanup(): void {
    const now = Date.now();
    let evicted = 0;
    
    for (const [tierName, tier] of Object.entries(this.tiers)) {
      const ttl = this.ttls[tierName as keyof typeof this.ttls];
      
      for (const [address, entry] of tier.entries()) {
        if (now - entry.timestamp > ttl) {
          tier.delete(address);
          evicted++;
        }
      }
    }
    
    if (evicted > 0) {
      console.log(`🧹 Evicted ${evicted} expired cache entries`);
    }
  }
}

export class OptimizedHolderAnalysisService {
  private helius: Helius;
  private connection: Connection;
  private cache: TieredHolderCache;
  private creditTracker: CreditTracker;
  private metricsCalculator: MetricsCalculator;
  private patternDetector: PatternDetector;
  private rateLimiter: RateLimiter;
  private dbPool: any;
  
  // Parallel processing configuration (optimized for Helius 10 RPS limit)
  private readonly PARALLEL_BATCH_SIZE = 20; // Can handle more with 10 RPS
  private readonly MAX_CONCURRENT_REQUESTS = 5; // Safe with rate limiter
  
  // Known system addresses to exclude
  private readonly SYSTEM_ADDRESSES = new Set([
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
    '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
    'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
  ]);

  constructor() {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      throw new Error('HELIUS_API_KEY environment variable is required');
    }

    this.helius = new Helius(apiKey);
    this.connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`);
    this.dbPool = getDbPool();
    this.cache = new TieredHolderCache(this.dbPool);
    this.creditTracker = CreditTracker.getInstance(10_000_000);
    this.metricsCalculator = new MetricsCalculator();
    this.patternDetector = new PatternDetector();
    this.rateLimiter = new RateLimiter(600, 10); // 10 per second for DAS/Enhanced APIs (Helius Developer plan)
    
    // Schedule periodic cache cleanup
    setInterval(() => this.cache.cleanup(), 600000); // Every 10 minutes
  }

  async analyzeToken(
    mint: string, 
    bondingCurveProgress: number,
    priority: 'high' | 'medium' | 'low' = 'medium'
  ): Promise<AnalysisResult | null> {
    const startTime = Date.now();
    let totalCredits = 0;

    try {
      // Adjust analysis depth based on priority
      const analysisDepth = this.getAnalysisDepth(priority);
      
      // Get bonding curve address
      const bondingCurveAddress = await this.getBondingCurveAddress(mint);

      // Stage 1: Get holder list with pagination
      console.log(`📊 Fetching holders for ${mint} (${priority} priority)...`);
      const holders = await this.fetchHoldersListOptimized(mint, bondingCurveAddress, analysisDepth.maxHolders);
      totalCredits += Math.ceil(holders.length / 1000);

      // For instant analysis of high-tech tokens, analyze even with few holders
      if (holders.length < analysisDepth.minHolders) {
        // Only skip if it's not a high priority token with very high technical score
        if (priority !== 'high' || holders.length < 3) {
          console.log(`Insufficient holders (${holders.length}), skipping analysis`);
          return null;
        }
        console.log(`⚠️ Low holder count (${holders.length}) but analyzing due to high priority`);
      }

      // Stage 2: Smart sampling for large holder lists
      const sampledHolders = this.smartSample(holders, analysisDepth.sampleSize);

      // Stage 3: Check cache with tiered system
      const { cached, uncached } = await this.cache.partition(sampledHolders);
      const cacheHitRate = cached.length / sampledHolders.length;
      console.log(`✅ Cache hit: ${cached.length}/${sampledHolders.length} wallets (${(cacheHitRate * 100).toFixed(1)}%)`);

      // Stage 4: Parallel batch enrichment for uncached wallets
      let newWalletData: EnrichedHolder[] = [];
      if (uncached.length > 0) {
        console.log(`🔄 Enriching ${uncached.length} new wallets...`);
        newWalletData = await this.parallelBatchEnrich(uncached, sampledHolders);
        totalCredits += uncached.length * 2;
      }

      // Stage 5: Calculate metrics
      const allHolders = [...cached, ...newWalletData];
      const metrics = await this.calculateAllMetrics(allHolders, mint);

      // Stage 6: Calculate scores
      const score = this.calculateScore(metrics);

      // Stage 7: Generate alerts
      const alerts = this.generateAlerts(metrics, score);

      // Stage 8: Save to database and update token
      await this.saveSnapshot(mint, metrics, score, totalCredits);
      await this.updateTokenAfterAnalysis(mint, score.total);

      const processingTime = Date.now() - startTime;
      console.log(`✅ Analysis complete in ${processingTime}ms using ${totalCredits} credits`);

      return {
        token: {
          mint,
          symbol: await this.getTokenSymbol(mint),
          bondingCurveProgress
        },
        metrics,
        score,
        alerts,
        timestamp: new Date(),
        apiCreditsUsed: totalCredits,
        cacheHitRate,
        processingTimeMs: processingTime
      };

    } catch (error) {
      console.error(`Error analyzing token ${mint}:`, error);
      return null;
    }
  }

  private getAnalysisDepth(priority: 'high' | 'medium' | 'low') {
    switch (priority) {
      case 'high':
        return {
          maxHolders: 10000,
          sampleSize: 500,
          minHolders: 3,  // Reduced from 10 for instant analysis
          enrichmentDepth: 'full'
        };
      case 'medium':
        return {
          maxHolders: 5000,
          sampleSize: 250,
          minHolders: 5,
          enrichmentDepth: 'standard'
        };
      case 'low':
        return {
          maxHolders: 2000,
          sampleSize: 100,
          minHolders: 5,
          enrichmentDepth: 'minimal'
        };
    }
  }

  private smartSample(holders: Holder[], targetSize: number): Holder[] {
    if (holders.length <= targetSize) {
      return holders;
    }

    // Sort by balance
    const sorted = [...holders].sort((a, b) => b.balance - a.balance);
    
    const sampled: Holder[] = [];
    
    // Always include top 20%
    const topCount = Math.floor(targetSize * 0.4);
    sampled.push(...sorted.slice(0, topCount));
    
    // Include bottom 10% to detect distribution
    const bottomCount = Math.floor(targetSize * 0.1);
    sampled.push(...sorted.slice(-bottomCount));
    
    // Random sample from middle
    const middleCount = targetSize - topCount - bottomCount;
    const middleStart = topCount;
    const middleEnd = sorted.length - bottomCount;
    const middleHolders = sorted.slice(middleStart, middleEnd);
    
    for (let i = 0; i < middleCount && i < middleHolders.length; i++) {
      const randomIndex = Math.floor(Math.random() * middleHolders.length);
      sampled.push(middleHolders[randomIndex]);
    }
    
    return sampled;
  }

  private async fetchHoldersListOptimized(
    mint: string, 
    bondingCurveAddress: string | null,
    maxHolders: number
  ): Promise<Holder[]> {
    const holders: Holder[] = [];
    let page = 1;
    const limit = 1000;

    while (holders.length < maxHolders) {
      try {
        // Use rate limiter with retry logic
        const response = await this.rateLimiter.execute(async () => 
          this.helius.rpc.getTokenAccounts({
            mint,
            limit,
            page
          })
        );

        if (!response?.token_accounts || response.token_accounts.length === 0) {
          break;
        }

        // Filter and add holders
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
        await this.sleep(20); // Reduced delay for faster fetching

      } catch (error) {
        console.error(`Error fetching holders page ${page}:`, error);
        break;
      }
    }

    return holders;
  }

  private async parallelBatchEnrich(
    wallets: string[], 
    allHolders: Holder[]
  ): Promise<EnrichedHolder[]> {
    const enriched: EnrichedHolder[] = [];
    const semaphore = new Array(this.MAX_CONCURRENT_REQUESTS);
    
    // Create chunks for parallel processing
    const chunks: string[][] = [];
    for (let i = 0; i < wallets.length; i += this.PARALLEL_BATCH_SIZE) {
      chunks.push(wallets.slice(i, i + this.PARALLEL_BATCH_SIZE));
    }
    
    // Process chunks in parallel with concurrency limit
    for (const chunk of chunks) {
      const chunkPromises = chunk.map((wallet, index) => 
        this.enrichSingleWalletOptimized(wallet, index * 100) // Increased delay to 100ms between requests
      );
      
      const chunkResults = await Promise.allSettled(chunkPromises);
      
      for (const result of chunkResults) {
        if (result.status === 'fulfilled' && result.value) {
          const walletData = result.value;
          const holder = allHolders.find(h => h.address === walletData.address);
          
          if (holder) {
            enriched.push({
              ...walletData,
              ...holder,
              tokenBalance: holder.balance
            });
          }
          
          // Update cache
          this.cache.set(walletData.address, walletData);
        }
      }
      
      // Brief pause between chunks
      await this.sleep(50);
    }
    
    return enriched;
  }

  private async enrichSingleWalletOptimized(address: string, delay: number = 0): Promise<WalletData> {
    if (delay > 0) {
      await this.sleep(delay);
    }

    try {
      const pubkey = new PublicKey(address);
      
      // Fetch only essential data with rate limiting
      const [signatures, balance] = await Promise.all([
        this.rateLimiter.execute(() => 
          this.connection.getSignaturesForAddress(pubkey, { limit: 50 })
        ),
        this.rateLimiter.execute(() => 
          this.connection.getBalance(pubkey)
        )
      ]);

      if (!signatures || signatures.length === 0) {
        return this.getDefaultWalletData(address);
      }

      const oldestTx = signatures[signatures.length - 1];
      const newestTx = signatures[0];

      const createdAt = oldestTx.blockTime ? new Date(oldestTx.blockTime * 1000) : new Date();
      const lastActive = newestTx.blockTime ? new Date(newestTx.blockTime * 1000) : new Date();
      const walletAge = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

      // Quick pattern detection
      const isBot = this.patternDetector.detectBot({
        address,
        createdAt,
        lastActive,
        transactionCount: signatures.length,
        buyCount: 0,
        sellCount: 0,
        solBalance: balance / 1e9,
        walletAge,
        signatures
      });

      const isSmartMoney = walletAge > 90 && balance > 10e9; // Simplified check

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
        buyCount: 0,
        sellCount: 0,
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

  private async getTokenSymbol(mint: string): Promise<string> {
    try {
      const result = await this.dbPool.query(
        'SELECT symbol FROM tokens WHERE mint_address = $1',
        [mint]
      );
      return result.rows[0]?.symbol || mint.slice(0, 8);
    } catch (error) {
      return mint.slice(0, 8);
    }
  }

  private async updateTokenAfterAnalysis(mint: string, score: number): Promise<void> {
    try {
      await this.dbPool.query(
        'SELECT update_token_after_holder_analysis((SELECT id FROM tokens WHERE mint_address = $1), $2)',
        [mint, score]
      );
    } catch (error) {
      console.error('Error updating token after analysis:', error);
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
    let distributionScore = 0;
    
    // Special handling for very low holder counts
    if (metrics.distribution.uniqueHolders < 10) {
      // For tokens with very few holders, apply penalties but still give some score
      const holderPenalty = Math.max(0.3, metrics.distribution.uniqueHolders / 10);
      
      // Gini coefficient (40 points) - reduced for low holders
      if (metrics.distribution.giniCoefficient < 0.3) distributionScore += 40 * holderPenalty;
      else if (metrics.distribution.giniCoefficient < 0.5) distributionScore += 30 * holderPenalty;
      else if (metrics.distribution.giniCoefficient < 0.7) distributionScore += 20 * holderPenalty;
      else if (metrics.distribution.giniCoefficient < 0.8) distributionScore += 10 * holderPenalty;
      
      // Concentration (40 points) - reduced for low holders
      if (metrics.distribution.top1Percent < 5) distributionScore += 40 * holderPenalty;
      else if (metrics.distribution.top1Percent < 10) distributionScore += 30 * holderPenalty;
      else if (metrics.distribution.top1Percent < 15) distributionScore += 20 * holderPenalty;
      else if (metrics.distribution.top1Percent < 20) distributionScore += 10 * holderPenalty;
      
      // Holder count (31 points) - heavily penalized
      distributionScore += Math.min(31, Math.floor(metrics.distribution.uniqueHolders * 2)) * holderPenalty;
    } else {
      // Normal scoring for adequate holder counts
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
    }

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
          organic_growth_score, overall_risk, api_credits_used,
          cache_hit_rate, processing_time_ms
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
        creditsUsed,
        this.cache.getStats().hitRate,
        0 // Will be updated by caller
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

  async getApiUsageStats() {
    return this.creditTracker.getStats();
  }

  async getCacheStats() {
    return this.cache.getStats();
  }
}