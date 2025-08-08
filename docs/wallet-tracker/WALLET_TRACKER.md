# Wallet Tracker System - Advanced Smart Money Identification

## Overview
A comprehensive wallet tracking system that identifies and scores successful traders based on their performance with graduated tokens. The system monitors early buyers of tokens that graduate from Pump.fun to Raydium, calculates their PnL with advanced edge case handling, detects wallet relationships to prevent gaming, and assigns scores to create a reliable "smart money" signal for token evaluation.

## Core Objectives
1. **Track Graduated Token Performance**: Monitor tokens that successfully graduate (84 SOL threshold)
2. **Identify Legitimate Early Buyers**: Find wallets that bought before graduation, filtering out bots and coordinated groups
3. **Calculate Accurate Trader PnL**: Track realized and unrealized profits with comprehensive edge case handling
4. **Score Traders with Anti-Gaming Measures**: Assign performance scores with Sybil resistance
5. **Generate High-Quality Signals**: Use validated trader scores to influence token scoring in main system
6. **Scale Efficiently**: Handle 100k+ wallets and 10k+ transactions/minute

## System Architecture

### 1. Data Collection Pipeline with Multi-Source Redundancy

#### 1.1 Graduated Token Tracking
```typescript
// Enhanced with fallback mechanisms and validation
interface GraduatedTokenData {
  mint_address: string;
  graduation_timestamp: Date;
  graduation_signature: string;
  graduation_price: number;
  peak_price: number;
  final_market_cap: number;
  migration_platform: 'raydium' | 'meteora' | 'other';
  data_source: 'primary' | 'fallback' | 'local_cache';
  validation_status: 'verified' | 'pending' | 'disputed';
}

// Data source management with automatic failover
interface DataSourceManager {
  primary: DataSource;      // Helius API
  secondary: DataSource;    // Shyft API
  tertiary: DataSource;     // Direct RPC
  cache: DataSource;        // Local database cache
  
  async fetchWithFallback<T>(operation: string): Promise<T> {
    for (const source of [this.primary, this.secondary, this.tertiary, this.cache]) {
      try {
        return await source.fetch(operation);
      } catch (error) {
        console.warn(`Source ${source.name} failed, trying next...`);
        continue;
      }
    }
    throw new Error('All data sources failed');
  }
}
```

#### 1.2 Advanced Wallet Analysis with Sybil Detection
```typescript
interface WalletProfile {
  wallet_address: string;
  wallet_type: 'normal' | 'bot' | 'dev' | 'whale' | 'sybil' | 'influencer';
  
  // Relationship tracking
  connected_wallets: string[];      // Wallets with frequent interactions
  cluster_id?: string;              // Identified wallet cluster
  cluster_confidence: number;       // 0-1 confidence in cluster detection
  
  // Behavior patterns
  trading_patterns: TradingPattern[];
  avg_response_time_ms: number;     // Time between token launch and first buy
  coordination_score: number;       // Likelihood of coordinated trading (0-1)
  
  // Reputation
  reputation_score: number;          // Based on historical behavior
  manual_verification?: {
    verified_by: string;
    verified_at: Date;
    verification_notes: string;
  };
}

interface WalletCluster {
  cluster_id: string;
  wallets: string[];
  cluster_type: 'family' | 'bot_network' | 'trading_group' | 'unknown';
  shared_patterns: Pattern[];
  risk_score: number;              // 0-1, higher = more suspicious
  total_combined_pnl: number;
  detection_confidence: number;
}
```

#### 1.3 Trade Tracking
```typescript
interface WalletTrade {
  wallet_address: string;
  token_mint: string;
  trade_type: 'buy' | 'sell';
  amount: number;
  price: number;
  timestamp: Date;
  transaction_hash: string;
  sol_value: number;
}
```

### 2. Enhanced Database Schema with Performance Optimization

#### 2.1 Core Tables with Partitioning

```sql
-- Partitioned wallet traders table for scalability
CREATE TABLE wallet_traders (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) UNIQUE NOT NULL,
  
  -- Enhanced wallet classification
  wallet_type VARCHAR(20) DEFAULT 'normal',
  cluster_id VARCHAR(36),
  cluster_confidence DECIMAL(3, 2),
  reputation_score DECIMAL(10, 2) DEFAULT 50,
  
  -- Activity tracking
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMP NOT NULL DEFAULT NOW(),
  total_trades INTEGER DEFAULT 0,
  graduated_tokens_traded INTEGER DEFAULT 0,
  
  -- Performance metrics
  total_pnl_sol DECIMAL(20, 9) DEFAULT 0,
  total_pnl_usd DECIMAL(20, 2) DEFAULT 0,
  win_rate DECIMAL(5, 2) DEFAULT 0,
  avg_hold_time_minutes INTEGER DEFAULT 0,
  
  -- Enhanced scoring with decay
  trader_score DECIMAL(10, 2) DEFAULT 0,
  score_updated_at TIMESTAMP,
  score_decay_factor DECIMAL(3, 2) DEFAULT 1.0,
  days_inactive INTEGER DEFAULT 0,
  
  -- Anti-gaming measures
  suspicious_activity_count INTEGER DEFAULT 0,
  last_audit_at TIMESTAMP,
  audit_notes JSONB DEFAULT '{}',
  
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE wallet_traders_2024_01 PARTITION OF wallet_traders
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
-- Continue for each month...

-- Wallet relationship graph
CREATE TABLE wallet_relationships (
  id SERIAL PRIMARY KEY,
  wallet_a VARCHAR(44) NOT NULL,
  wallet_b VARCHAR(44) NOT NULL,
  relationship_type VARCHAR(30) NOT NULL, -- 'funds_transfer', 'same_tx_pattern', 'timing_correlation'
  interaction_count INTEGER DEFAULT 1,
  confidence_score DECIMAL(3, 2),
  first_interaction TIMESTAMP,
  last_interaction TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_a, wallet_b, relationship_type)
);

CREATE INDEX idx_wallet_relationships_graph ON wallet_relationships USING GIN (
  ARRAY[wallet_a, wallet_b]
);

-- Wallet clusters for Sybil detection
CREATE TABLE wallet_clusters (
  cluster_id VARCHAR(36) PRIMARY KEY,
  cluster_type VARCHAR(30) NOT NULL,
  wallet_count INTEGER NOT NULL,
  primary_wallet VARCHAR(44),
  risk_score DECIMAL(3, 2),
  detection_method VARCHAR(50),
  detection_confidence DECIMAL(3, 2),
  combined_pnl_sol DECIMAL(20, 9),
  combined_score DECIMAL(10, 2),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Wallet trades history
CREATE TABLE wallet_trades (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  trade_type VARCHAR(10) NOT NULL, -- 'buy' or 'sell'
  amount DECIMAL(20, 6) NOT NULL,
  price_sol DECIMAL(20, 9) NOT NULL,
  price_usd DECIMAL(20, 6),
  sol_value DECIMAL(20, 9) NOT NULL,
  transaction_hash VARCHAR(88) NOT NULL,
  block_time TIMESTAMP NOT NULL,
  is_graduated_token BOOLEAN DEFAULT FALSE,
  time_to_graduation_minutes INTEGER, -- NULL if not graduated or sold before
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  FOREIGN KEY (wallet_address) REFERENCES wallet_traders(wallet_address),
  INDEX idx_wallet_trades_wallet (wallet_address),
  INDEX idx_wallet_trades_token (token_mint),
  INDEX idx_wallet_trades_time (block_time)
);

-- Wallet token positions
CREATE TABLE wallet_positions (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  total_bought DECIMAL(20, 6) DEFAULT 0,
  total_sold DECIMAL(20, 6) DEFAULT 0,
  current_balance DECIMAL(20, 6) DEFAULT 0,
  avg_buy_price DECIMAL(20, 9),
  avg_sell_price DECIMAL(20, 9),
  realized_pnl_sol DECIMAL(20, 9) DEFAULT 0,
  unrealized_pnl_sol DECIMAL(20, 9) DEFAULT 0,
  first_buy_at TIMESTAMP,
  last_sell_at TIMESTAMP,
  is_graduated BOOLEAN DEFAULT FALSE,
  graduation_entry_timing INTEGER, -- minutes before graduation
  position_score DECIMAL(10, 2) DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_address, token_mint),
  FOREIGN KEY (wallet_address) REFERENCES wallet_traders(wallet_address),
  INDEX idx_positions_performance (realized_pnl_sol DESC)
);

-- Wallet scoring history
CREATE TABLE wallet_scores_history (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) NOT NULL,
  score_timestamp TIMESTAMP NOT NULL,
  trader_score DECIMAL(10, 2) NOT NULL,
  components JSONB NOT NULL, -- Breakdown of score components
  graduated_tokens_count INTEGER,
  total_pnl_sol DECIMAL(20, 9),
  win_rate DECIMAL(5, 2),
  avg_multiplier DECIMAL(10, 2),
  consistency_score DECIMAL(10, 2),
  timing_score DECIMAL(10, 2),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  FOREIGN KEY (wallet_address) REFERENCES wallet_traders(wallet_address),
  INDEX idx_scores_wallet_time (wallet_address, score_timestamp DESC)
);

-- Token smart money signals
CREATE TABLE token_smart_money_signals (
  id SERIAL PRIMARY KEY,
  token_mint VARCHAR(44) NOT NULL,
  signal_timestamp TIMESTAMP NOT NULL,
  smart_wallets_count INTEGER DEFAULT 0,
  avg_trader_score DECIMAL(10, 2),
  total_smart_money_invested_sol DECIMAL(20, 9),
  top_traders JSONB DEFAULT '[]', -- Array of top trader addresses and scores
  signal_strength DECIMAL(5, 2), -- 0-100
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  INDEX idx_smart_signals_token (token_mint),
  INDEX idx_smart_signals_time (signal_timestamp DESC)
);
```

### 3. Advanced Wallet Scoring Methodology with Anti-Gaming

#### 3.1 Enhanced Score Components (1000 points total)

##### A. Verified Profitability (600 points) - With Sybil Resistance
```typescript
interface EnhancedProfitabilityMetrics {
  // Core profitability (400 points)
  totalPnLSol: number;        // 200 points (with cluster penalty)
  totalPnLUsd: number;        // 150 points (historical USD value)
  avgReturnMultiple: number;  // 50 points (average X on investments)
  
  // Quality metrics (200 points)
  organicProfitRatio: number;  // 100 points (profit from non-clustered trades)
  sustainedProfitability: number; // 50 points (consistent over time)
  bestVerifiedTrade: number;   // 50 points (best trade outside cluster)
}

// Calculation with Sybil penalty
calculateProfitabilityScore(wallet: WalletData): number {
  let baseScore = this.calculateBaseProfitScore(wallet);
  
  // Apply cluster penalty if detected
  if (wallet.cluster_id) {
    const clusterPenalty = Math.max(0.3, 1 - wallet.cluster_confidence);
    baseScore *= clusterPenalty;
  }
  
  // Apply reputation bonus/penalty
  const reputationMultiplier = 0.5 + (wallet.reputation_score / 100);
  baseScore *= reputationMultiplier;
  
  return Math.min(600, baseScore);
}
```

##### B. Consistency & Legitimacy (200 points)
```typescript
interface LegitimacyMetrics {
  winRate: number;                // 50 points
  profitConsistency: number;      // 50 points
  graduationHitRate: number;      // 50 points
  behaviorLegitimacy: number;     // 50 points (non-bot patterns)
}
```

##### C. Smart Timing & Execution (150 points)
```typescript
interface SmartTimingMetrics {
  earlyEntryScore: number;        // 50 points (not too early = bot)
  exitEfficiency: number;         // 50 points
  marketTimingSkill: number;      // 50 points (buying in different market conditions)
}
```

##### D. Sustainable Activity (50 points)
```typescript
interface SustainableActivityMetrics {
  consistentVolume: number;       // 20 points (steady, not burst)
  diversification: number;        // 20 points (multiple tokens)
  longevity: number;             // 10 points (active over time)
}
```

#### 3.2 Dynamic Score Decay with Activity-Based Adjustment
```typescript
class EnhancedWalletScorer {
  calculateDecayFactor(wallet: WalletData): number {
    const daysSinceLastTrade = this.getDaysSinceLastTrade(wallet);
    
    // Progressive decay based on inactivity
    if (daysSinceLastTrade <= 7) return 1.0;
    if (daysSinceLastTrade <= 14) return 0.95;
    if (daysSinceLastTrade <= 30) return 0.85;
    if (daysSinceLastTrade <= 60) return 0.70;
    if (daysSinceLastTrade <= 90) return 0.50;
    return 0.30; // Minimum decay factor
  }
  
  adjustScoreForMarketConditions(score: number, wallet: WalletData): number {
    // Adjust based on current market volatility
    const marketVolatility = this.getCurrentMarketVolatility();
    const performanceInVolatility = this.getWalletVolatilityPerformance(wallet);
    
    // Reward wallets that perform well in current conditions
    const conditionMultiplier = 0.8 + (performanceInVolatility * 0.4);
    return score * conditionMultiplier;
  }
}
```

### 4. Sybil Attack Detection & Prevention

#### 4.1 Wallet Relationship Graph Analysis
```typescript
class SybilDetector {
  async detectWalletClusters(minClusterSize: number = 3): Promise<WalletCluster[]> {
    // Build relationship graph
    const graph = await this.buildWalletGraph();
    
    // Detect clusters using multiple methods
    const clusters = await Promise.all([
      this.detectByFundingPatterns(graph),
      this.detectByTimingCorrelation(graph),
      this.detectByTradingPatterns(graph),
      this.detectBySocialGraphAnalysis(graph)
    ]);
    
    // Merge and validate clusters
    return this.mergeAndValidateClusters(clusters.flat(), minClusterSize);
  }
  
  private async detectByFundingPatterns(graph: WalletGraph): Promise<WalletCluster[]> {
    // Find wallets funded from same source
    const fundingClusters = [];
    const fundingSources = await this.identifyFundingSources(graph);
    
    for (const source of fundingSources) {
      const fundedWallets = await this.getWalletsFundedBy(source);
      if (fundedWallets.length >= 3) {
        fundingClusters.push({
          cluster_id: uuid(),
          wallets: fundedWallets,
          cluster_type: 'funding_related',
          risk_score: this.calculateFundingRiskScore(fundedWallets),
          detection_confidence: 0.8
        });
      }
    }
    
    return fundingClusters;
  }
  
  private async detectByTimingCorrelation(graph: WalletGraph): Promise<WalletCluster[]> {
    // Find wallets that trade within seconds of each other
    const timingClusters = [];
    const correlations = await this.calculateTimingCorrelations(graph);
    
    for (const correlation of correlations) {
      if (correlation.score > 0.8) { // High correlation
        timingClusters.push({
          cluster_id: uuid(),
          wallets: correlation.wallets,
          cluster_type: 'timing_coordinated',
          risk_score: correlation.score,
          detection_confidence: 0.9
        });
      }
    }
    
    return timingClusters;
  }
}
```

### 5. Enhanced Integration with Megatron Token Scoring

#### 5.1 Validated Smart Money Signal Generation
```typescript
interface ValidatedSmartMoneySignal {
  tokenMint: string;
  
  // Verified smart wallets (excluding clusters)
  verifiedWallets: {
    address: string;
    traderScore: number;
    clusterStatus: 'none' | 'member' | 'excluded';
    investmentSize: number;
    entryPrice: number;
    profitHistory: number;
    reputationScore: number;
  }[];
  
  // Cluster analysis
  detectedClusters: {
    cluster_id: string;
    wallet_count: number;
    combined_investment: number;
    risk_score: number;
  }[];
  
  // Adjusted scores
  rawWalletScore: number;        // Before adjustments
  clusterPenalty: number;        // Penalty for cluster activity
  finalWalletScore: number;      // 0-333 contribution to token score
  signalQuality: 'high' | 'medium' | 'low' | 'suspicious';
  
  timestamp: Date;
}

class ValidatedTokenWalletScoring {
  calculateWalletScore(tokenMint: string): number {
    const buyers = await this.getTokenBuyers(tokenMint);
    
    // Filter and validate smart buyers
    const { verified, clustered } = await this.validateSmartBuyers(buyers);
    
    // Calculate base score from verified wallets
    const verifiedScore = this.calculateVerifiedWalletsScore(verified);
    
    // Apply cluster penalty
    const clusterPenalty = this.calculateClusterPenalty(clustered);
    
    // Dynamic threshold based on market conditions
    const marketAdjustment = this.getMarketConditionAdjustment();
    
    const finalScore = (verifiedScore - clusterPenalty) * marketAdjustment;
    
    return Math.max(0, Math.min(333, finalScore));
  }
  
  private calculateVerifiedWalletsScore(wallets: VerifiedWallet[]): number {
    // Weight by reputation and historical performance
    let weightedScore = 0;
    let totalWeight = 0;
    
    for (const wallet of wallets) {
      const weight = wallet.reputationScore * wallet.historicalROI;
      weightedScore += wallet.traderScore * weight;
      totalWeight += weight;
    }
    
    return totalWeight > 0 ? (weightedScore / totalWeight) * 333 : 0;
  }
}
```

### 6. Resource Requirements & Capacity Planning

#### 6.1 Infrastructure Requirements
```yaml
# Minimum Production Requirements
database:
  type: PostgreSQL with TimescaleDB
  storage: 500GB SSD (scales to 2TB)
  memory: 32GB RAM
  cpu: 8 cores
  partitioning: Monthly for time-series data
  
cache:
  type: Redis Cluster
  memory: 16GB RAM (scales to 64GB)
  persistence: AOF with 1-second fsync
  
compute:
  api_servers: 3x (4 cores, 8GB RAM each)
  worker_nodes: 5x (8 cores, 16GB RAM each)
  monitoring: 1x (4 cores, 8GB RAM)
  
network:
  bandwidth: 1Gbps minimum
  latency: <10ms to Solana RPC
  
# Scaling Estimates
capacity:
  wallets: 100,000 active, 1M total
  transactions: 10,000/minute peak
  api_requests: 1,000/second
  storage_growth: ~10GB/month
```

#### 6.2 Performance Targets & SLAs
```yaml
performance_targets:
  data_collection:
    graduated_tokens_per_hour: 100
    transaction_fetch_rate: 10,000/minute
    api_fallback_time: <500ms
    
  pnl_calculation:
    wallets_per_minute: 1,000
    position_accuracy: 99.9%
    calculation_latency: <100ms
    
  scoring:
    score_update_frequency: 1 hour
    batch_size: 10,000 wallets
    cache_hit_rate: >85%
    
  real_time:
    transaction_latency: <1 second
    signal_generation: <500ms
    websocket_connections: 10,000 concurrent
    
  api:
    response_time_p50: <50ms
    response_time_p99: <500ms
    availability: 99.9%
```
```typescript
class TokenWalletScoring {
  calculateWalletScore(tokenMint: string): number {
    // Get all wallets that bought this token
    const buyers = await this.getTokenBuyers(tokenMint);
    
    // Filter for tracked/smart wallets
    const smartBuyers = buyers.filter(b => b.traderScore > 700);
    
    // Component 1: Smart Wallet Count (100 points)
    const walletCountScore = this.calculateWalletCountScore(smartBuyers); // 0-100
    
    // Component 2: Average Trader Quality (133 points)
    const avgTraderScore = this.calculateAvgTraderQuality(smartBuyers); // 0-133
    
    // Component 3: Total Smart Money Investment (100 points)
    const investmentScore = this.calculateInvestmentScore(smartBuyers); // 0-100
    
    return walletCountScore + avgTraderScore + investmentScore; // 0-333
  }
  
  calculateWalletCountScore(smartBuyers: Wallet[]): number {
    // Scoring based on number of smart wallets
    // 1 wallet = 20 points, 5+ wallets = 100 points
    const count = smartBuyers.length;
    if (count === 0) return 0;
    if (count === 1) return 20;
    if (count === 2) return 40;
    if (count === 3) return 60;
    if (count === 4) return 80;
    return 100; // 5+ wallets
  }
  
  calculateAvgTraderQuality(smartBuyers: Wallet[]): number {
    if (smartBuyers.length === 0) return 0;
    
    // Weight by investment size and wallet score
    let weightedScore = 0;
    let totalWeight = 0;
    
    for (const buyer of smartBuyers) {
      // Higher weight for wallets with proven profitability
      const profitWeight = Math.min(buyer.profitHistory / 1000, 10); // Cap at 10x
      const weight = buyer.investmentSize * profitWeight;
      
      // Normalize wallet score from 0-1000 to 0-133
      const normalizedScore = (buyer.traderScore / 1000) * 133;
      
      weightedScore += normalizedScore * weight;
      totalWeight += weight;
    }
    
    return totalWeight > 0 ? weightedScore / totalWeight : 0;
  }
  
  calculateInvestmentScore(smartBuyers: Wallet[]): number {
    // Total SOL invested by smart money
    const totalInvestment = smartBuyers.reduce((sum, b) => sum + b.investmentSize, 0);
    
    // Scoring tiers
    if (totalInvestment < 10) return 0;      // < 10 SOL
    if (totalInvestment < 50) return 25;     // 10-50 SOL
    if (totalInvestment < 100) return 50;    // 50-100 SOL
    if (totalInvestment < 250) return 75;    // 100-250 SOL
    return 100;                               // 250+ SOL
  }
}

// Complete Token Scoring (999 Points)
class MegatronTokenScoring {
  async calculateTotalScore(tokenMint: string): number {
    const technicalScore = await this.getTechnicalScore(tokenMint);  // 0-333
    const holderScore = await this.getHolderScore(tokenMint);        // 0-333
    const walletScore = await this.getWalletScore(tokenMint);        // 0-333
    
    return technicalScore + holderScore + walletScore;               // 0-999
  }
}
```

### 7. Implementation Phases (Revised Timeline)

#### Phase 0: Infrastructure & Foundation (Week 0.5)
- Set up development and staging environments
- Configure data sources with fallback mechanisms
- Implement core utilities and error handling
- Establish monitoring and logging infrastructure

#### Phase 1: Historical Data Collection with Validation (Week 1-2)
- Query all graduated tokens with multi-source validation
- Implement robust transaction fetching with retries
- Build wallet profile foundation with basic classification
- Establish data quality validation procedures

#### Phase 2: PnL Calculation with Edge Cases (Week 2-3)
- Implement FIFO matching with complex scenarios
- Handle rug pulls, partial sells, and DCA strategies
- Build position tracking with state management
- Create PnL validation and reconciliation system

#### Phase 3: Scoring System with Anti-Gaming (Week 3-4)
- Implement Sybil detection and cluster analysis
- Build reputation system with decay mechanisms
- Create dynamic scoring with market adjustments
- Develop manual verification workflow

#### Phase 4: Real-time Monitoring at Scale (Week 4-5)
- Implement scalable WebSocket infrastructure
- Build transaction processing pipeline with queues
- Create multi-tier caching system
- Develop alert and notification system

#### Phase 5: Integration, Testing & Optimization (Week 5-6)
- Complete Megatron integration
- Comprehensive testing suite
- Performance optimization and tuning
- Production deployment with monitoring

#### Phase 6: Post-Launch Optimization (Ongoing)
- Monitor and adjust scoring algorithms
- Refine Sybil detection patterns
- Optimize performance bottlenecks
- Expand wallet coverage and data sources

### 8. Monitoring, Alerts & Governance

#### 8.1 Enhanced Alert System
```typescript
interface AlertConfiguration {
  // Critical alerts (immediate action required)
  critical: {
    dataSourceFailure: boolean;
    scoringSystemDown: boolean;
    sybilAttackDetected: boolean;
    apiLatencyHigh: boolean;
  };
  
  // Warning alerts (investigation needed)
  warning: {
    highClusterActivity: boolean;
    unusualTradingPatterns: boolean;
    scoreManipulationAttempt: boolean;
    cacheHitRateLow: boolean;
  };
  
  // Informational alerts
  info: {
    newHighScoreWallet: boolean;
    significantGraduation: boolean;
    marketRegimeChange: boolean;
  };
}
```

#### 8.2 Governance & Manual Oversight
```typescript
interface GovernanceSystem {
  // Manual wallet verification process
  verificationQueue: WalletVerificationRequest[];
  verificationTeam: string[]; // Authorized verifiers
  verificationConsensus: number; // Required approvals
  
  // Score adjustment authority
  scoreAdjustmentRequests: ScoreAdjustmentRequest[];
  adjustmentApprovalThreshold: number;
  
  // Cluster review process
  clusterReviewQueue: ClusterReviewRequest[];
  clusterWhitelist: string[]; // Legitimate clusters (e.g., funds)
  
  // System parameter governance
  parameterChanges: ParameterChangeProposal[];
  votingPeriod: number; // Hours
  executionDelay: number; // Hours after approval
}
```

### 7. Technical Implementation Details

#### 7.1 Data Sources
```typescript
// Primary: Existing Megatron monitors
const dataSources = {
  graduations: 'graduation_monitor',
  transactions: 'transaction_monitor', 
  prices: 'price_monitor',
  pools: 'pool_monitor'
};

// Secondary: Direct RPC queries for historical data
const rpcEndpoints = {
  helius: process.env.HELIUS_API_KEY,
  shyft: process.env.X_TOKEN
};
```

#### 7.2 Processing Pipeline
```typescript
class WalletTrackingPipeline {
  async processGraduatedToken(tokenMint: string) {
    // 1. Get graduation details
    const graduation = await this.getGraduationData(tokenMint);
    
    // 2. Fetch all transactions before graduation
    const transactions = await this.getPreGraduationTransactions(
      tokenMint, 
      graduation.timestamp
    );
    
    // 3. Extract unique buyers
    const buyers = this.extractUniqueBuyers(transactions);
    
    // 4. Calculate entry metrics for each buyer
    const buyerMetrics = await this.calculateBuyerMetrics(buyers);
    
    // 5. Update wallet profiles
    await this.updateWalletProfiles(buyerMetrics);
    
    // 6. Recalculate scores
    await this.recalculateScores(buyers);
  }
}
```

#### 7.3 Real-time Monitoring
```typescript
class SmartMoneyMonitor {
  async monitorTransaction(transaction: ParsedTransaction) {
    // Check if wallet is tracked
    const wallet = await this.getWallet(transaction.signer);
    
    if (wallet && wallet.trader_score > 700) {
      // Generate smart money signal
      const signal = await this.generateSignal(
        transaction.tokenMint,
        wallet
      );
      
      // Emit signal to token scoring system
      this.emitSmartMoneySignal(signal);
      
      // Store signal for analysis
      await this.storeSignal(signal);
    }
  }
}
```

### 8. API Endpoints

```typescript
// GET /api/wallets/top
// Returns top performing wallets
{
  wallets: [{
    address: string,
    score: number,
    pnl: number,
    winRate: number,
    lastActive: Date
  }]
}

// GET /api/wallets/:address
// Returns detailed wallet profile
{
  address: string,
  score: number,
  metrics: {...},
  recentTrades: [...],
  topPerformers: [...]
}

// GET /api/tokens/:mint/smart-money
// Returns smart money signals for a token
{
  tokenMint: string,
  signals: [...],
  smartWalletCount: number,
  signalStrength: number
}

// GET /api/analytics/wallet-performance
// Returns aggregate wallet performance metrics
{
  totalWallets: number,
  avgScore: number,
  topPerformers: [...],
  recentGraduations: [...]
}
```

### 9. Monitoring & Alerts

#### 9.1 Alert Conditions
- High-score wallet (>850) makes large purchase
- Multiple smart wallets buy same token within 5 minutes
- Sudden spike in smart money activity
- New wallet achieves high score quickly

#### 9.2 Dashboard Components
- Top traders leaderboard
- Smart money flow visualization
- Real-time signal feed
- Wallet performance charts
- Token correlation matrix

### 10. Future Enhancements

#### 10.1 Machine Learning Integration
- Predict wallet behavior patterns
- Cluster wallets by trading style
- Anomaly detection for unusual trades
- Feature importance analysis

#### 10.2 Advanced Features
- Wallet relationship mapping (connected wallets)
- Copy trading detection
- Insider trading patterns
- Cross-chain wallet tracking
- Social media correlation

#### 10.3 Performance Optimizations
- Redis caching for frequently accessed wallets
- Batch processing for historical data
- Parallel processing for score calculations
- Incremental updates instead of full recalculation

## Getting Started

### Prerequisites
```bash
# System requirements
- Node.js 18+
- PostgreSQL 14+ with TimescaleDB
- Redis 6+
- Docker & Docker Compose
- 32GB+ RAM, 8+ CPU cores

# API Keys required
- Helius API key (primary data source)
- Shyft API key (fallback data source)  
- Direct RPC endpoint (tertiary fallback)
```

### Quick Start
```bash
# 1. Clone and setup
git clone <repository>
cd wallet-tracker
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your configuration

# 3. Setup infrastructure
docker-compose up -d postgres redis

# 4. Run migrations
npm run db:migrate

# 5. Start services
npm run start:collector  # Data collection
npm run start:calculator # PnL calculation  
npm run start:scorer     # Scoring system
npm run start:monitor    # Real-time monitoring
npm run start:api        # REST API

# 6. Access dashboard
open http://localhost:3001
```

### Configuration
```env
# .env configuration
# Data Sources
HELIUS_API_KEY=your_key
SHYFT_API_KEY=your_key
RPC_ENDPOINT=https://api.mainnet-beta.solana.com
DATA_SOURCE_TIMEOUT=5000
DATA_SOURCE_RETRY_COUNT=3

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=wallet_tracker
DB_USER=postgres
DB_PASSWORD=secure_password
DB_POOL_SIZE=20

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=optional_password
REDIS_CLUSTER=false

# Scoring Configuration
MIN_WALLET_SCORE=700         # Minimum score for "smart money"
SIGNAL_THRESHOLD=5            # Min verified wallets for signal (adjusted from 3)
SCORE_DECAY_DAYS=7            # Days before decay starts
CLUSTER_PENALTY_MAX=0.7       # Maximum cluster penalty
REPUTATION_WEIGHT=0.3         # Weight of reputation in scoring

# Performance
BATCH_SIZE=1000
WORKER_CONCURRENCY=10
CACHE_TTL=300
MAX_WEBSOCKET_CONNECTIONS=10000

# Monitoring
SENTRY_DSN=your_sentry_dsn
LOG_LEVEL=info
METRICS_PORT=9090
```

## Documentation

### API Reference
- [REST API Documentation](./docs/api/README.md)
- [WebSocket API Documentation](./docs/websocket/README.md)
- [Database Schema](./docs/database/schema.md)
- [Scoring Algorithm Details](./docs/scoring/algorithm.md)

### Development Guides
- [Contributing Guide](./CONTRIBUTING.md)
- [Testing Guide](./docs/testing/README.md)
- [Deployment Guide](./docs/deployment/README.md)
- [Performance Tuning](./docs/performance/tuning.md)

## License

MIT License - See LICENSE file for details

### 9. Success Criteria & KPIs

#### 9.1 Primary Success Metrics
- **Signal Accuracy**: >75% of high-score wallet picks graduate
- **Early Detection**: Signals fire >45 minutes before graduation
- **Sybil Resistance**: <5% of scored wallets in malicious clusters
- **System Reliability**: 99.9% uptime with <1% data loss

#### 9.2 Secondary Performance Metrics
- **Coverage**: Track >85% of graduated token early buyers
- **Processing Speed**: <100ms for new transaction processing
- **API Performance**: <50ms p50 response time
- **Cache Efficiency**: >85% cache hit rate
- **Cost Efficiency**: <$0.01 per wallet per month

### 10. Risk Management & Mitigation

#### 10.1 Technical Risks
| Risk | Impact | Probability | Mitigation |
|------|--------|------------|-----------|
| Data source failure | High | Medium | Multi-source redundancy, local caching |
| Sybil attack | High | High | Cluster detection, reputation system |
| Performance degradation | Medium | Medium | Horizontal scaling, caching layers |
| Data inconsistency | High | Low | Validation checks, reconciliation |

#### 10.2 Operational Risks
| Risk | Impact | Probability | Mitigation |
|------|--------|------------|-----------|
| API rate limiting | Medium | High | Request pooling, multiple API keys |
| Storage overflow | Medium | Medium | Data partitioning, archival strategy |
| Scoring manipulation | High | Medium | Anti-gaming measures, manual review |
| Market regime change | Medium | High | Dynamic scoring adjustments |