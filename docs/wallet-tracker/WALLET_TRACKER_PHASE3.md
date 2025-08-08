# Phase 3: Scoring System (Week 3-4)

## Overview
The third phase implements the comprehensive wallet scoring system that evaluates traders based on their profitability, consistency, timing, and risk management. This scoring system forms the foundation for identifying "smart money" and generating valuable signals for token evaluation.

## Objectives
1. Implement the 1000-point wallet scoring algorithm (heavily weighted for profitability)
2. Calculate component scores for each scoring dimension
3. Create score history tracking and decay mechanisms  
4. Build ranking and percentile systems
5. Generate smart money signals based on scores
6. Integrate wallet scores into token evaluation (0-333 points)

## Technical Architecture

### 3.1 Core Scoring Engine

```typescript
// src/wallet-tracker/scoring/wallet-scorer.ts

interface WalletScoringConfig {
  // Profitability weights (600 points total)
  profitability: {
    totalPnLSol: 250,      // Absolute SOL profit
    totalPnLUsd: 200,      // USD profit
    avgReturnMultiple: 100, // Average X on investments
    bestTradeROI: 50       // Highest single trade
  };
  
  // Consistency weights (200 points)
  consistency: {
    winRate: 80,           // Win percentage
    profitConsistency: 60, // Std deviation of returns
    graduationHitRate: 60  // Graduated tokens caught
  };
  
  // Timing weights (150 points)
  timing: {
    earlyEntryScore: 75,   // Buying before crowd
    exitEfficiency: 75     // Selling near tops
  };
  
  // Activity weights (50 points)
  activity: {
    tradingVolume: 30,     // Total SOL traded
    activeTokens: 20       // Graduated tokens traded
  };
}

class WalletScorer {
  private config: WalletScoringConfig;
  private percentileCache: Map<string, number> = new Map();
  
  async calculateWalletScore(walletAddress: string): Promise<WalletScore> {
    // Get wallet data
    const walletData = await this.getWalletData(walletAddress);
    const pnlData = await this.getPnLData(walletAddress);
    const positionData = await this.getPositionData(walletAddress);
    
    // Calculate component scores
    const profitabilityScore = await this.calculateProfitabilityScore(walletData, pnlData);
    const consistencyScore = await this.calculateConsistencyScore(walletData, positionData);
    const timingScore = await this.calculateTimingScore(walletData, positionData);
    const activityScore = await this.calculateActivityScore(walletData);
    
    // Calculate total score
    const totalScore = 
      profitabilityScore.total +
      consistencyScore.total +
      timingScore.total +
      activityScore.total;
    
    // Apply decay factor for inactive wallets
    const decayFactor = this.calculateDecayFactor(walletData.last_activity_at);
    const finalScore = totalScore * decayFactor;
    
    // Calculate percentile ranking
    const percentileRank = await this.calculatePercentileRank(finalScore);
    
    return {
      wallet_address: walletAddress,
      total_score: finalScore,
      percentile_rank: percentileRank,
      components: {
        profitability: profitabilityScore,
        consistency: consistencyScore,
        timing: timingScore,
        activity: activityScore
      },
      decay_factor: decayFactor,
      calculated_at: new Date(),
      metadata: {
        total_pnl_sol: pnlData.total_pnl_sol,
        total_pnl_usd: pnlData.total_pnl_usd,
        win_rate: walletData.win_rate,
        graduated_tokens: walletData.graduated_tokens_traded,
        last_activity: walletData.last_activity_at
      }
    };
  }
  
  async calculateProfitabilityScore(
    wallet: WalletData,
    pnl: PnLData
  ): Promise<ComponentScore> {
    const scores = {
      totalPnLSol: 0,
      totalPnLUsd: 0,
      avgReturnMultiple: 0,
      bestTradeROI: 0
    };
    
    // Total PnL SOL (250 points) - Exponential curve favoring top performers
    const solProfitPercentile = await this.getPercentileRank('pnl_sol', pnl.total_pnl_sol);
    scores.totalPnLSol = this.exponentialScore(solProfitPercentile, 250);
    
    // Total PnL USD (200 points) - $100k = full points
    const usdScore = Math.min(1, pnl.total_pnl_usd / 100000);
    scores.totalPnLUsd = Math.pow(usdScore, 0.7) * 200;
    
    // Average Return Multiple (100 points) - 10x average = full points
    const avgMultiple = pnl.total_returned / pnl.total_invested;
    scores.avgReturnMultiple = Math.min(100, avgMultiple * 10);
    
    // Best Trade ROI (50 points) - 25x best trade = full points
    const bestROI = await this.getBestTradeROI(wallet.wallet_address);
    scores.bestTradeROI = Math.min(50, bestROI * 2);
    
    return {
      total: Object.values(scores).reduce((a, b) => a + b, 0),
      breakdown: scores,
      max_possible: 600
    };
  }
  
  async calculateConsistencyScore(
    wallet: WalletData,
    positions: PositionData[]
  ): Promise<ComponentScore> {
    const scores = {
      winRate: 0,
      profitConsistency: 0,
      graduationHitRate: 0
    };
    
    // Win Rate (80 points) - Linear scaling
    scores.winRate = (wallet.win_rate / 100) * 80;
    
    // Profit Consistency (60 points) - Lower std dev = higher score
    const returns = positions.map(p => p.roi_percentage);
    const stdDev = this.calculateStandardDeviation(returns);
    const consistencyFactor = Math.max(0, 1 - (stdDev / 100));
    scores.profitConsistency = consistencyFactor * 60;
    
    // Graduation Hit Rate (60 points)
    const graduatedPositions = positions.filter(p => p.is_graduated);
    const graduationRate = graduatedPositions.length / Math.max(1, positions.length);
    scores.graduationHitRate = graduationRate * 60;
    
    return {
      total: Object.values(scores).reduce((a, b) => a + b, 0),
      breakdown: scores,
      max_possible: 200
    };
  }
  
  async calculateTimingScore(
    wallet: WalletData,
    positions: PositionData[]
  ): Promise<ComponentScore> {
    const scores = {
      earlyEntryScore: 0,
      exitEfficiency: 0
    };
    
    // Early Entry Score (75 points) - How early before graduation
    const earlyEntries = positions.filter(p => p.graduation_entry_timing !== null);
    if (earlyEntries.length > 0) {
      const avgEntryTiming = earlyEntries.reduce(
        (sum, p) => sum + (p.graduation_entry_timing || 0), 0
      ) / earlyEntries.length;
      
      // Score based on minutes before graduation (earlier = better)
      // 240+ minutes (4+ hours) = full points
      scores.earlyEntryScore = Math.min(75, (avgEntryTiming / 240) * 75);
    }
    
    // Exit Efficiency (75 points) - Selling near peaks
    const exitEfficiency = await this.calculateExitEfficiency(positions);
    scores.exitEfficiency = exitEfficiency * 75;
    
    return {
      total: Object.values(scores).reduce((a, b) => a + b, 0),
      breakdown: scores,
      max_possible: 150
    };
  }
  
  async calculateActivityScore(wallet: WalletData): Promise<ComponentScore> {
    const scores = {
      tradingVolume: 0,
      activeTokens: 0
    };
    
    // Trading Volume (30 points) - 1000+ SOL = full points
    const volumePercentile = await this.getPercentileRank('volume', wallet.total_volume_sol);
    scores.tradingVolume = (volumePercentile / 100) * 30;
    
    // Active Tokens (20 points) - 50+ graduated tokens = full points
    scores.activeTokens = Math.min(20, (wallet.graduated_tokens_traded / 50) * 20);
    
    return {
      total: Object.values(scores).reduce((a, b) => a + b, 0),
      breakdown: scores,
      max_possible: 50
    };
  }
  
  private exponentialScore(percentile: number, maxPoints: number): number {
    // Exponential curve: top 1% get full points, top 10% get 70%, etc.
    return Math.pow(percentile / 100, 0.5) * maxPoints;
  }
  
  private calculateDecayFactor(lastActivity: Date): number {
    const daysSinceActivity = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24);
    
    // Minimal decay for profitable wallets
    // 80% score retention after 60 days of inactivity
    return Math.max(0.8, 1 - (daysSinceActivity / 60) * 0.2);
  }
  
  private async calculateExitEfficiency(positions: PositionData[]): Promise<number> {
    const closedPositions = positions.filter(p => p.status === 'closed');
    
    if (closedPositions.length === 0) return 0;
    
    let totalEfficiency = 0;
    
    for (const position of closedPositions) {
      // Get price at exit and peak price within holding period
      const exitPrice = position.avg_exit_price;
      const peakPrice = await this.getPeakPriceDuringHold(
        position.token_mint,
        position.first_entry_time,
        position.last_exit_time
      );
      
      const efficiency = peakPrice > 0 ? exitPrice / peakPrice : 0;
      totalEfficiency += efficiency;
    }
    
    return totalEfficiency / closedPositions.length;
  }
}
```

### 3.2 Percentile Ranking System

```typescript
// src/wallet-tracker/scoring/percentile-ranker.ts

class PercentileRanker {
  private cache: NodeCache;
  private updateInterval: number = 3600000; // 1 hour
  
  constructor() {
    this.cache = new NodeCache({ stdTTL: 3600 });
    this.startPeriodicUpdate();
  }
  
  async calculatePercentiles(): Promise<void> {
    console.log('Calculating wallet percentiles...');
    
    // Get all wallet scores
    const walletScores = await this.db.query(`
      SELECT 
        wallet_address,
        trader_score,
        total_pnl_sol,
        total_pnl_usd,
        win_rate,
        graduated_tokens_traded
      FROM wallet_traders
      WHERE trader_score IS NOT NULL
      ORDER BY trader_score DESC
    `);
    
    // Calculate percentiles for each metric
    const metrics = [
      'trader_score',
      'total_pnl_sol',
      'total_pnl_usd',
      'win_rate',
      'graduated_tokens_traded'
    ];
    
    for (const metric of metrics) {
      const values = walletScores.map(w => w[metric]).sort((a, b) => a - b);
      const percentiles = this.calculatePercentilesForValues(values);
      
      // Cache percentile thresholds
      this.cache.set(`percentiles:${metric}`, percentiles);
    }
    
    // Update wallet percentile ranks
    await this.updateWalletPercentiles(walletScores);
  }
  
  private calculatePercentilesForValues(values: number[]): PercentileThresholds {
    const n = values.length;
    
    return {
      p1: values[Math.floor(n * 0.01)],
      p5: values[Math.floor(n * 0.05)],
      p10: values[Math.floor(n * 0.10)],
      p25: values[Math.floor(n * 0.25)],
      p50: values[Math.floor(n * 0.50)], // Median
      p75: values[Math.floor(n * 0.75)],
      p90: values[Math.floor(n * 0.90)],
      p95: values[Math.floor(n * 0.95)],
      p99: values[Math.floor(n * 0.99)]
    };
  }
  
  async getPercentileRank(metric: string, value: number): Promise<number> {
    const percentiles = this.cache.get(`percentiles:${metric}`) as PercentileThresholds;
    
    if (!percentiles) {
      await this.calculatePercentiles();
      return this.getPercentileRank(metric, value);
    }
    
    // Determine percentile rank
    if (value >= percentiles.p99) return 99;
    if (value >= percentiles.p95) return 95;
    if (value >= percentiles.p90) return 90;
    if (value >= percentiles.p75) return 75;
    if (value >= percentiles.p50) return 50;
    if (value >= percentiles.p25) return 25;
    if (value >= percentiles.p10) return 10;
    if (value >= percentiles.p5) return 5;
    if (value >= percentiles.p1) return 1;
    return 0;
  }
  
  async getTopWallets(limit: number = 100): Promise<WalletRanking[]> {
    return await this.db.query(`
      SELECT 
        wallet_address,
        trader_score,
        percentile_rank,
        total_pnl_sol,
        total_pnl_usd,
        win_rate,
        graduated_tokens_traded,
        last_activity_at
      FROM wallet_traders
      WHERE trader_score IS NOT NULL
      ORDER BY trader_score DESC
      LIMIT $1
    `, [limit]);
  }
  
  private startPeriodicUpdate(): void {
    setInterval(async () => {
      try {
        await this.calculatePercentiles();
        console.log('Percentiles updated successfully');
      } catch (error) {
        console.error('Failed to update percentiles:', error);
      }
    }, this.updateInterval);
  }
}
```

### 3.3 Token Wallet Score Calculator (0-333 Points)

```typescript
// src/wallet-tracker/scoring/token-wallet-scorer.ts

interface TokenWalletScore {
  token_mint: string;
  wallet_score: number; // 0-333
  components: {
    smart_wallet_count: number;    // 0-100
    avg_trader_quality: number;    // 0-133
    total_investment: number;       // 0-100
  };
  smart_wallets: SmartWalletBuyer[];
  calculated_at: Date;
}

class TokenWalletScorer {
  private walletScorer: WalletScorer;
  private smartMoneyThreshold: number = 700; // Minimum wallet score
  
  async calculateTokenWalletScore(tokenMint: string): Promise<TokenWalletScore> {
    // Get all buyers of this token
    const buyers = await this.getTokenBuyers(tokenMint);
    
    // Filter for smart money wallets
    const smartBuyers = await this.identifySmartBuyers(buyers);
    
    // Calculate component scores
    const walletCountScore = this.calculateWalletCountScore(smartBuyers);
    const traderQualityScore = await this.calculateTraderQualityScore(smartBuyers);
    const investmentScore = this.calculateInvestmentScore(smartBuyers);
    
    const totalScore = walletCountScore + traderQualityScore + investmentScore;
    
    return {
      token_mint: tokenMint,
      wallet_score: Math.min(333, totalScore),
      components: {
        smart_wallet_count: walletCountScore,
        avg_trader_quality: traderQualityScore,
        total_investment: investmentScore
      },
      smart_wallets: smartBuyers,
      calculated_at: new Date()
    };
  }
  
  private async identifySmartBuyers(buyers: TokenBuyer[]): Promise<SmartWalletBuyer[]> {
    const smartBuyers: SmartWalletBuyer[] = [];
    
    for (const buyer of buyers) {
      // Get wallet score
      const walletData = await this.db.query(`
        SELECT 
          trader_score,
          total_pnl_sol,
          total_pnl_usd,
          win_rate,
          graduated_tokens_traded
        FROM wallet_traders
        WHERE wallet_address = $1
      `, [buyer.wallet_address]);
      
      if (walletData.length > 0 && walletData[0].trader_score >= this.smartMoneyThreshold) {
        smartBuyers.push({
          ...buyer,
          trader_score: walletData[0].trader_score,
          profit_history_sol: walletData[0].total_pnl_sol,
          profit_history_usd: walletData[0].total_pnl_usd,
          win_rate: walletData[0].win_rate
        });
      }
    }
    
    return smartBuyers;
  }
  
  private calculateWalletCountScore(smartBuyers: SmartWalletBuyer[]): number {
    // 0-100 points based on number of smart wallets
    const count = smartBuyers.length;
    
    if (count === 0) return 0;
    if (count === 1) return 20;
    if (count === 2) return 40;
    if (count === 3) return 60;
    if (count === 4) return 80;
    return 100; // 5+ wallets
  }
  
  private async calculateTraderQualityScore(smartBuyers: SmartWalletBuyer[]): Promise<number> {
    // 0-133 points based on average trader quality weighted by investment and profitability
    if (smartBuyers.length === 0) return 0;
    
    let weightedScore = 0;
    let totalWeight = 0;
    
    for (const buyer of smartBuyers) {
      // Weight factors
      const profitWeight = Math.min(buyer.profit_history_sol / 1000, 10); // Cap at 10x
      const investmentWeight = Math.min(buyer.investment_size / 10, 5); // Cap at 5x for 50+ SOL
      const scoreWeight = buyer.trader_score / 1000; // Normalize to 0-1
      
      const combinedWeight = profitWeight * investmentWeight * scoreWeight;
      
      // Normalize wallet score from 0-1000 to 0-133
      const normalizedScore = (buyer.trader_score / 1000) * 133;
      
      weightedScore += normalizedScore * combinedWeight;
      totalWeight += combinedWeight;
    }
    
    return totalWeight > 0 ? weightedScore / totalWeight : 0;
  }
  
  private calculateInvestmentScore(smartBuyers: SmartWalletBuyer[]): number {
    // 0-100 points based on total SOL invested by smart money
    const totalInvestment = smartBuyers.reduce((sum, b) => sum + b.investment_size, 0);
    
    if (totalInvestment < 10) return 0;       // < 10 SOL
    if (totalInvestment < 50) return 25;      // 10-50 SOL  
    if (totalInvestment < 100) return 50;     // 50-100 SOL
    if (totalInvestment < 250) return 75;     // 100-250 SOL
    return 100;                                // 250+ SOL
  }
  
  async generateSmartMoneySignal(tokenMint: string): Promise<SmartMoneySignal> {
    const score = await this.calculateTokenWalletScore(tokenMint);
    
    // Determine signal strength (0-100)
    const signalStrength = (score.wallet_score / 333) * 100;
    
    return {
      token_mint: tokenMint,
      wallet_score: score.wallet_score,
      signal_strength: signalStrength,
      smart_wallets: score.smart_wallets,
      components: score.components,
      timestamp: new Date(),
      alert_level: this.determineAlertLevel(signalStrength)
    };
  }
  
  private determineAlertLevel(signalStrength: number): 'high' | 'medium' | 'low' | 'none' {
    if (signalStrength >= 75) return 'high';
    if (signalStrength >= 50) return 'medium';
    if (signalStrength >= 25) return 'low';
    return 'none';
  }
}
```

### 3.4 Score History & Tracking

```typescript
// src/wallet-tracker/scoring/score-history.ts

class ScoreHistoryTracker {
  async recordScoreSnapshot(walletScore: WalletScore): Promise<void> {
    // Store in history table
    await this.db.query(`
      INSERT INTO wallet_scores_history (
        wallet_address,
        score_timestamp,
        trader_score,
        components,
        graduated_tokens_count,
        total_pnl_sol,
        win_rate,
        avg_multiplier,
        consistency_score,
        timing_score
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      walletScore.wallet_address,
      walletScore.calculated_at,
      walletScore.total_score,
      JSON.stringify(walletScore.components),
      walletScore.metadata.graduated_tokens,
      walletScore.metadata.total_pnl_sol,
      walletScore.metadata.win_rate,
      walletScore.components.profitability.breakdown.avgReturnMultiple,
      walletScore.components.consistency.total,
      walletScore.components.timing.total
    ]);
    
    // Update main wallet record
    await this.updateWalletTraderScore(walletScore);
    
    // Check for significant changes
    await this.checkScoreChanges(walletScore);
  }
  
  async updateWalletTraderScore(walletScore: WalletScore): Promise<void> {
    await this.db.query(`
      UPDATE wallet_traders
      SET 
        trader_score = $2,
        score_updated_at = $3,
        percentile_rank = $4,
        score_components = $5,
        updated_at = NOW()
      WHERE wallet_address = $1
    `, [
      walletScore.wallet_address,
      walletScore.total_score,
      walletScore.calculated_at,
      walletScore.percentile_rank,
      JSON.stringify(walletScore.components)
    ]);
  }
  
  async checkScoreChanges(walletScore: WalletScore): Promise<void> {
    // Get previous score
    const previousScore = await this.getPreviousScore(walletScore.wallet_address);
    
    if (!previousScore) return;
    
    const changePercent = ((walletScore.total_score - previousScore.trader_score) / previousScore.trader_score) * 100;
    
    // Alert on significant changes
    if (Math.abs(changePercent) > 20) {
      await this.createScoreAlert({
        wallet_address: walletScore.wallet_address,
        previous_score: previousScore.trader_score,
        new_score: walletScore.total_score,
        change_percent: changePercent,
        reason: await this.analyzeScoreChange(walletScore, previousScore)
      });
    }
  }
  
  async getScoreHistory(
    walletAddress: string,
    days: number = 30
  ): Promise<ScoreHistory[]> {
    return await this.db.query(`
      SELECT 
        score_timestamp,
        trader_score,
        components,
        total_pnl_sol,
        win_rate
      FROM wallet_scores_history
      WHERE wallet_address = $1
        AND score_timestamp > NOW() - INTERVAL '%s days'
      ORDER BY score_timestamp DESC
    `, [walletAddress, days]);
  }
  
  async getScoreTrend(walletAddress: string): Promise<ScoreTrend> {
    const history = await this.getScoreHistory(walletAddress, 30);
    
    if (history.length < 2) {
      return { trend: 'stable', change: 0 };
    }
    
    const recent = history[0].trader_score;
    const oldest = history[history.length - 1].trader_score;
    const change = recent - oldest;
    const changePercent = (change / oldest) * 100;
    
    return {
      trend: change > 0 ? 'rising' : change < 0 ? 'falling' : 'stable',
      change: changePercent,
      current: recent,
      previous: oldest
    };
  }
}
```

### 3.5 Batch Scoring Processor

```typescript
// src/wallet-tracker/scoring/batch-scorer.ts

class BatchScoringProcessor {
  private queue: Bull.Queue;
  private scorer: WalletScorer;
  private batchSize: number = 50;
  
  constructor() {
    this.queue = new Bull('wallet-scoring', {
      redis: {
        host: 'localhost',
        port: 6379
      }
    });
    
    this.scorer = new WalletScorer();
    this.setupWorkers();
  }
  
  private setupWorkers() {
    this.queue.process('score-wallet', 10, async (job) => {
      const { walletAddress } = job.data;
      
      try {
        // Calculate score
        const score = await this.scorer.calculateWalletScore(walletAddress);
        
        // Record history
        const historyTracker = new ScoreHistoryTracker();
        await historyTracker.recordScoreSnapshot(score);
        
        // Check if wallet qualifies as smart money
        if (score.total_score >= 700) {
          await this.markAsSmartMoney(walletAddress, score);
        }
        
        return {
          success: true,
          wallet: walletAddress,
          score: score.total_score,
          percentile: score.percentile_rank
        };
      } catch (error) {
        console.error(`Scoring failed for ${walletAddress}:`, error);
        throw error;
      }
    });
    
    // Process token wallet scores
    this.queue.process('score-token-wallets', 5, async (job) => {
      const { tokenMint } = job.data;
      
      const tokenScorer = new TokenWalletScorer();
      const tokenScore = await tokenScorer.calculateTokenWalletScore(tokenMint);
      
      // Store token wallet score
      await this.storeTokenWalletScore(tokenScore);
      
      // Generate signal if significant
      if (tokenScore.wallet_score > 100) {
        const signal = await tokenScorer.generateSmartMoneySignal(tokenMint);
        await this.emitSmartMoneySignal(signal);
      }
      
      return {
        success: true,
        token: tokenMint,
        wallet_score: tokenScore.wallet_score
      };
    });
  }
  
  async scoreAllWallets(): Promise<void> {
    // Get wallets that need scoring
    const wallets = await this.db.query(`
      SELECT wallet_address
      FROM wallet_traders
      WHERE 
        score_updated_at IS NULL
        OR score_updated_at < NOW() - INTERVAL '24 hours'
      ORDER BY total_pnl_sol DESC
      LIMIT 10000
    `);
    
    console.log(`Scoring ${wallets.length} wallets...`);
    
    // Add to queue in batches
    for (let i = 0; i < wallets.length; i += this.batchSize) {
      const batch = wallets.slice(i, i + this.batchSize);
      
      const jobs = batch.map(w => ({
        name: 'score-wallet',
        data: { walletAddress: w.wallet_address },
        opts: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          }
        }
      }));
      
      await this.queue.addBulk(jobs);
      
      // Progress update
      if (i % 500 === 0) {
        console.log(`Queued ${i} / ${wallets.length} wallets`);
      }
    }
  }
  
  async rescoreTopWallets(): Promise<void> {
    // Rescore top 1000 wallets daily
    const topWallets = await this.db.query(`
      SELECT wallet_address
      FROM wallet_traders
      WHERE trader_score IS NOT NULL
      ORDER BY trader_score DESC
      LIMIT 1000
    `);
    
    for (const wallet of topWallets) {
      await this.queue.add('score-wallet', {
        walletAddress: wallet.wallet_address
      }, {
        priority: 1 // Higher priority for top wallets
      });
    }
  }
}
```

## Implementation Steps

### Step 1: Database Setup
```bash
# Create scoring tables
npx ts-node src/database/migrations/003_create_scoring_tables.sql

# Create indexes for performance
npx ts-node src/wallet-tracker/scripts/create-scoring-indexes.ts
```

### Step 2: Initialize Scoring System
```typescript
// src/wallet-tracker/scripts/initialize-scoring.ts

async function initializeScoring() {
  console.log('Initializing wallet scoring system...');
  
  // Step 1: Calculate initial percentiles
  const ranker = new PercentileRanker();
  await ranker.calculatePercentiles();
  console.log('Percentiles calculated');
  
  // Step 2: Start batch processor
  const processor = new BatchScoringProcessor();
  
  // Step 3: Score all wallets
  await processor.scoreAllWallets();
  
  // Step 4: Monitor progress
  const interval = setInterval(async () => {
    const stats = await processor.getQueueStats();
    console.log(`Queue stats: ${JSON.stringify(stats)}`);
    
    if (stats.waiting === 0 && stats.active === 0) {
      clearInterval(interval);
      console.log('Initial scoring complete!');
      
      // Generate report
      await generateScoringReport();
    }
  }, 5000);
}

async function generateScoringReport() {
  const report = await db.query(`
    SELECT 
      COUNT(*) as total_scored,
      AVG(trader_score) as avg_score,
      MAX(trader_score) as max_score,
      MIN(trader_score) as min_score,
      COUNT(CASE WHEN trader_score >= 700 THEN 1 END) as smart_money_count,
      COUNT(CASE WHEN trader_score >= 900 THEN 1 END) as elite_traders
    FROM wallet_traders
    WHERE trader_score IS NOT NULL
  `);
  
  console.log('Scoring Report:', report[0]);
  
  // Get top 10 wallets
  const topWallets = await db.query(`
    SELECT 
      wallet_address,
      trader_score,
      total_pnl_sol,
      win_rate
    FROM wallet_traders
    ORDER BY trader_score DESC
    LIMIT 10
  `);
  
  console.log('Top 10 Wallets:', topWallets);
}

initializeScoring().catch(console.error);
```

### Step 3: Setup Continuous Scoring
```typescript
// src/wallet-tracker/scripts/continuous-scoring.ts

class ContinuousScoring {
  private processor: BatchScoringProcessor;
  private ranker: PercentileRanker;
  
  async start() {
    this.processor = new BatchScoringProcessor();
    this.ranker = new PercentileRanker();
    
    // Schedule daily rescoring of top wallets
    cron.schedule('0 0 * * *', async () => {
      console.log('Starting daily top wallet rescoring...');
      await this.processor.rescoreTopWallets();
    });
    
    // Schedule hourly percentile updates
    cron.schedule('0 * * * *', async () => {
      console.log('Updating percentiles...');
      await this.ranker.calculatePercentiles();
    });
    
    // Real-time scoring for active wallets
    this.startRealTimeScoring();
  }
  
  private async startRealTimeScoring() {
    // Listen for new trades
    eventEmitter.on('new-trade', async (trade) => {
      // Queue wallet for rescoring
      await this.processor.queue.add('score-wallet', {
        walletAddress: trade.wallet_address
      }, {
        delay: 60000 // Delay 1 minute to batch multiple trades
      });
    });
    
    // Listen for graduated tokens
    eventEmitter.on('token-graduated', async (token) => {
      // Score all wallets that traded this token
      const wallets = await this.getTokenTraders(token.mint_address);
      
      for (const wallet of wallets) {
        await this.processor.queue.add('score-wallet', {
          walletAddress: wallet
        });
      }
    });
  }
}

const continuousScoring = new ContinuousScoring();
continuousScoring.start();
```

### Step 4: API Endpoints
```typescript
// src/wallet-tracker/api/scoring-endpoints.ts

router.get('/api/wallets/:address/score', async (req, res) => {
  const { address } = req.params;
  
  // Get current score
  const score = await db.query(`
    SELECT 
      trader_score,
      percentile_rank,
      score_components,
      score_updated_at
    FROM wallet_traders
    WHERE wallet_address = $1
  `, [address]);
  
  if (score.length === 0) {
    return res.status(404).json({ error: 'Wallet not found' });
  }
  
  // Get score history
  const history = await new ScoreHistoryTracker().getScoreHistory(address, 30);
  
  // Get score trend
  const trend = await new ScoreHistoryTracker().getScoreTrend(address);
  
  res.json({
    current: score[0],
    history,
    trend
  });
});

router.get('/api/wallets/leaderboard', async (req, res) => {
  const { limit = 100, offset = 0 } = req.query;
  
  const leaderboard = await db.query(`
    SELECT 
      wallet_address,
      trader_score,
      percentile_rank,
      total_pnl_sol,
      total_pnl_usd,
      win_rate,
      graduated_tokens_traded,
      last_activity_at
    FROM wallet_traders
    WHERE trader_score IS NOT NULL
    ORDER BY trader_score DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  
  res.json(leaderboard);
});

router.get('/api/tokens/:mint/wallet-score', async (req, res) => {
  const { mint } = req.params;
  
  const scorer = new TokenWalletScorer();
  const score = await scorer.calculateTokenWalletScore(mint);
  
  res.json(score);
});
```

## Performance Optimization

### 1. Score Caching
```typescript
class ScoreCache {
  private redis: Redis;
  private ttl: number = 3600; // 1 hour
  
  async getCachedScore(wallet: string): Promise<WalletScore | null> {
    const cached = await this.redis.get(`score:${wallet}`);
    return cached ? JSON.parse(cached) : null;
  }
  
  async setCachedScore(wallet: string, score: WalletScore): Promise<void> {
    await this.redis.setex(
      `score:${wallet}`,
      this.ttl,
      JSON.stringify(score)
    );
  }
}
```

### 2. Parallel Processing
```typescript
const pLimit = require('p-limit');
const limit = pLimit(10); // Max 10 concurrent scoring operations

async function scoreWalletsParallel(wallets: string[]) {
  const promises = wallets.map(wallet =>
    limit(() => scorer.calculateWalletScore(wallet))
  );
  
  return await Promise.all(promises);
}
```

### 3. Database Optimization
```sql
-- Create materialized view for fast scoring queries
CREATE MATERIALIZED VIEW wallet_scoring_stats AS
SELECT 
  wallet_address,
  total_pnl_sol,
  total_pnl_usd,
  win_rate,
  graduated_tokens_traded,
  COUNT(DISTINCT token_mint) as unique_tokens,
  AVG(roi_percentage) as avg_roi,
  MAX(roi_percentage) as best_roi
FROM wallet_positions
GROUP BY wallet_address;

CREATE UNIQUE INDEX ON wallet_scoring_stats(wallet_address);

-- Refresh periodically
REFRESH MATERIALIZED VIEW CONCURRENTLY wallet_scoring_stats;
```

## Monitoring & Validation

### Score Validation
```typescript
class ScoreValidator {
  async validateScores(): Promise<ValidationReport> {
    const checks = [];
    
    // Check 1: Scores within valid range (0-1000)
    const invalidScores = await this.checkScoreRange();
    checks.push({
      name: 'Score Range',
      passed: invalidScores.length === 0,
      details: invalidScores
    });
    
    // Check 2: Component scores sum correctly
    const componentErrors = await this.validateComponentSums();
    checks.push({
      name: 'Component Sums',
      passed: componentErrors.length === 0,
      details: componentErrors
    });
    
    // Check 3: Percentile ranks are consistent
    const percentileErrors = await this.validatePercentiles();
    checks.push({
      name: 'Percentile Ranks',
      passed: percentileErrors.length === 0,
      details: percentileErrors
    });
    
    return {
      passed: checks.every(c => c.passed),
      checks
    };
  }
}
```

## Success Metrics

### Target Metrics
- Score 100,000+ wallets
- Identify 1,000+ smart money wallets (score >700)
- Calculate token wallet scores for 10,000+ tokens
- Scoring speed: 100 wallets/second
- Cache hit rate: >70%
- API response time: <50ms

### Quality Metrics
- Score calculation accuracy: 99.9%
- Percentile rank accuracy: 99%
- Component score validation: 100%
- Historical tracking completeness: 100%

## Deliverables

1. **Scoring Engine**: Complete 1000-point scoring system
2. **Percentile System**: Dynamic percentile ranking
3. **Token Wallet Scores**: 0-333 point token evaluation
4. **Score History**: Complete tracking and trend analysis
5. **API Endpoints**: RESTful API for score access
6. **Leaderboard**: Top trader rankings

## Next Phase Prerequisites

Before moving to Phase 4 (Real-time Monitoring), ensure:
- [ ] All wallets scored
- [ ] Smart money wallets identified
- [ ] Token wallet scoring operational
- [ ] Percentile system working
- [ ] API endpoints tested
- [ ] Score validation passed