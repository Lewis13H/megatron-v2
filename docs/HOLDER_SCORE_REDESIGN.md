# Holder Score System Redesign for Pump.fun Tokens (333 Points)

## Overview

The Holder Score is a sophisticated wallet distribution analysis system that evaluates the health and organic growth potential of Pump.fun tokens. This system activates only when the bonding curve progress reaches 10-25%, providing early signals about token quality while avoiding premature judgments.

### Activation Criteria
- **Primary Trigger**: Bonding curve progress between 10-25%
- **Secondary Requirements**:
  - Minimum 50 unique holders
  - At least 100 transactions
  - 30 minutes since token creation
- **Deactivation**: Score freezes at 25% progress and transitions to mature token analysis

## Scoring System Breakdown (333 Points Total)

### 1. Distribution Health (111 Points)

#### Concentration Risk Analysis (40 points)
Evaluates how evenly tokens are distributed among holders.

**Metrics**:
- Gini Coefficient: 0-1 scale (lower is better)
- HHI (Herfindahl-Hirschman Index): Market concentration measure
- Top holder thresholds

**Scoring Formula**:
```typescript
const concentrationScore = (gini: number, hhi: number): number => {
  const giniScore = (1 - gini) * 20; // Max 20 points
  const hhiScore = Math.max(0, 20 - (hhi / 500)); // Max 20 points
  return giniScore + hhiScore;
};
```

#### Whale Detection (40 points)
Identifies and penalizes unhealthy whale concentrations.

**Thresholds**:
- No single wallet > 5%: 40 points
- No single wallet > 7%: 25 points
- No single wallet > 10%: 10 points
- Any wallet > 15%: 0 points (red flag)

**Connected Wallet Detection**:
```typescript
interface WhaleCriteria {
  maxSingleWallet: 0.05, // 5%
  maxTop5Wallets: 0.20,  // 20%
  maxTop10Wallets: 0.35, // 35%
  connectedWalletPenalty: 0.5 // 50% score reduction
}
```

#### Distribution Velocity (31 points)
Measures how quickly tokens are spreading to new holders.

**Formula**:
```typescript
const velocityScore = (
  newHoldersPerHour: number,
  totalHolders: number,
  timeElapsed: number
): number => {
  const growthRate = newHoldersPerHour / Math.sqrt(totalHolders);
  const organicFactor = Math.min(1, timeElapsed / 3600); // 1 hour baseline
  return Math.min(31, growthRate * organicFactor * 10);
};
```

### 2. Wallet Quality Analysis (111 Points)

#### Wallet Age & History (40 points)
Analyzes the quality of wallets holding the token.

**Metrics**:
- Average wallet age (days)
- Transaction history depth
- Previous successful trades
- ENS/domain ownership

**Implementation**:
```typescript
interface WalletQuality {
  age: number;          // Days since creation
  txCount: number;      // Total transactions
  tokenCount: number;   // Unique tokens held
  profitRatio: number;  // Historical profit ratio
  hasENS: boolean;      // Domain ownership
}

const calculateWalletScore = async (wallet: string): Promise<number> => {
  const history = await helius.getSignaturesForAddress({
    address: wallet,
    limit: 1000
  });
  
  const accountInfo = await helius.getAccountInfo(wallet);
  const age = (Date.now() - accountInfo.createdAt) / (1000 * 60 * 60 * 24);
  
  let score = 0;
  if (age > 90) score += 10;      // 90+ days
  else if (age > 30) score += 7;  // 30-90 days
  else if (age > 7) score += 4;   // 7-30 days
  
  // Transaction history
  if (history.length > 500) score += 10;
  else if (history.length > 100) score += 7;
  else if (history.length > 20) score += 4;
  
  // Profitable trader bonus
  const profitData = await analyzeProfitHistory(wallet);
  if (profitData.ratio > 1.5) score += 10;
  
  // ENS/Domain bonus
  if (await hasNameService(wallet)) score += 10;
  
  return score;
};
```

#### Diamond Hand Analysis (40 points)
Identifies holders likely to hold long-term vs quick flippers.

**Metrics**:
- Average holding time of previous tokens
- Sell pressure resistance score
- Portfolio diversity

**Algorithm**:
```typescript
const diamondHandScore = async (holders: string[]): Promise<number> => {
  let totalScore = 0;
  
  for (const holder of holders) {
    const portfolio = await helius.searchAssets({
      ownerAddress: holder,
      tokenType: 'fungible'
    });
    
    // Analyze holding patterns
    const holdingPatterns = await analyzeHoldingDuration(portfolio);
    const avgHoldTime = holdingPatterns.avgDays;
    
    if (avgHoldTime > 30) totalScore += 1;
    else if (avgHoldTime < 1) totalScore -= 0.5;
  }
  
  return Math.min(40, (totalScore / holders.length) * 40);
};
```

#### Bot Detection (31 points)
Identifies and penalizes bot activity.

**Detection Patterns**:
- Transaction timing analysis
- Wallet creation patterns
- Behavioral clustering
- MEV bot identification

```typescript
interface BotSignals {
  rapidTransactions: boolean;      // >10 tx in 1 minute
  uniformAmounts: boolean;         // Same buy amounts
  sequentialWallets: boolean;      // Created in sequence
  lowSOLBalance: boolean;          // <0.1 SOL
  singleTokenFocus: boolean;       // Only holds this token
  mevBotPattern: boolean;          // Known MEV signatures
}

const botDetectionScore = (signals: BotSignals): number => {
  let penalties = 0;
  if (signals.rapidTransactions) penalties += 10;
  if (signals.uniformAmounts) penalties += 8;
  if (signals.sequentialWallets) penalties += 5;
  if (signals.lowSOLBalance) penalties += 3;
  if (signals.singleTokenFocus) penalties += 3;
  if (signals.mevBotPattern) penalties += 10;
  
  return Math.max(0, 31 - penalties);
};
```

### 3. Activity Pattern Analysis (111 Points)

#### Organic Growth Detection (40 points)
Measures natural vs artificial growth patterns.

**Metrics**:
- Buy size distribution (should follow power law)
- Time between transactions (should be irregular)
- Geographic/timezone distribution
- Social correlation

```typescript
const organicGrowthScore = (
  transactions: Transaction[],
  socialData: SocialMetrics
): number => {
  // Analyze buy size distribution
  const sizes = transactions.map(tx => tx.amount);
  const powerLawFit = calculatePowerLawFit(sizes);
  const sizeScore = powerLawFit.r2 * 15; // Max 15 points
  
  // Time distribution analysis
  const timings = analyzeTransactionTimings(transactions);
  const timingScore = (1 - timings.regularity) * 15; // Max 15 points
  
  // Social correlation
  const socialCorrelation = correlateSocialActivity(transactions, socialData);
  const socialScore = socialCorrelation * 10; // Max 10 points
  
  return sizeScore + timingScore + socialScore;
};
```

#### Transaction Diversity (40 points)
Evaluates variety in transaction patterns.

**Components**:
- Unique DEX routers used
- Transaction size variance
- Buy/sell ratio balance
- Slippage tolerance patterns

```typescript
const transactionDiversityScore = async (
  mint: string,
  transactions: Transaction[]
): Promise<number> => {
  const dexRouters = new Set(transactions.map(tx => tx.program));
  const routerScore = Math.min(10, dexRouters.size * 2.5); // Max 10
  
  const sizeVariance = calculateVariance(transactions.map(tx => tx.amount));
  const varianceScore = Math.min(15, sizeVariance * 5); // Max 15
  
  const buySellRatio = transactions.filter(tx => tx.type === 'buy').length / 
                       transactions.length;
  const ratioScore = Math.min(15, Math.abs(0.7 - buySellRatio) * 50); // Max 15
  
  return routerScore + varianceScore + ratioScore;
};
```

#### Network Effects (31 points)
Measures interconnectedness of holder network.

**Analysis**:
- Holder interaction history
- Shared token ownership
- Transaction graph density
- Influencer participation

```typescript
const networkEffectsScore = async (
  holders: string[],
  tokenMint: string
): Promise<number> => {
  // Build interaction graph
  const graph = await buildHolderInteractionGraph(holders);
  
  // Calculate metrics
  const density = graph.edges / (graph.nodes * (graph.nodes - 1) / 2);
  const clustering = calculateClusteringCoefficient(graph);
  const centrality = calculateBetweenessCentrality(graph);
  
  // Score components
  const densityScore = Math.min(10, density * 100);
  const clusteringScore = Math.min(10, clustering * 20);
  const centralityScore = Math.min(11, (1 - centrality.max) * 15);
  
  return densityScore + clusteringScore + centralityScore;
};
```

## Implementation with Helius APIs

### Core Data Collection
```typescript
import { Helius } from "@helius-labs/sdk";

class HolderScoreAnalyzer {
  private helius: Helius;
  
  constructor(apiKey: string) {
    this.helius = new Helius(apiKey);
  }
  
  async analyzeToken(mint: string, bondingCurveProgress: number): Promise<HolderScore> {
    // Check activation criteria
    if (bondingCurveProgress < 10 || bondingCurveProgress > 25) {
      throw new Error("Holder Score only activates between 10-25% bonding curve");
    }
    
    // Fetch token holders
    const holders = await this.fetchAllHolders(mint);
    
    // Fetch detailed holder data
    const holderDetails = await this.enrichHolderData(holders);
    
    // Calculate scores
    const distributionScore = await this.calculateDistribution(holderDetails);
    const qualityScore = await this.calculateQuality(holderDetails);
    const activityScore = await this.calculateActivity(mint, holderDetails);
    
    return {
      total: distributionScore + qualityScore + activityScore,
      distribution: distributionScore,
      quality: qualityScore,
      activity: activityScore,
      timestamp: Date.now(),
      bondingCurveProgress
    };
  }
  
  private async fetchAllHolders(mint: string): Promise<string[]> {
    const holders = new Set<string>();
    let page = 1;
    
    while (true) {
      const response = await this.helius.rpc.getTokenAccounts({
        mint,
        page,
        limit: 1000
      });
      
      if (!response.token_accounts || response.token_accounts.length === 0) {
        break;
      }
      
      response.token_accounts.forEach(account => {
        if (account.amount > 0) {
          holders.add(account.owner);
        }
      });
      
      page++;
    }
    
    return Array.from(holders);
  }
  
  private async enrichHolderData(holders: string[]): Promise<HolderDetail[]> {
    const details = await Promise.all(
      holders.map(async (holder) => {
        const [balance, history, assets] = await Promise.all([
          this.helius.rpc.getBalance({ address: holder }),
          this.helius.rpc.getSignaturesForAddress({ address: holder, limit: 100 }),
          this.helius.rpc.searchAssets({ ownerAddress: holder, limit: 50 })
        ]);
        
        return {
          address: holder,
          balance,
          transactionCount: history.length,
          tokenCount: assets.items.length,
          accountAge: await this.getAccountAge(holder)
        };
      })
    );
    
    return details;
  }
}
```

### Integration with Megatron V2
```typescript
// src/scoring/holder-score.ts
export class PumpfunHolderScorer {
  private analyzer: HolderScoreAnalyzer;
  private cache: Map<string, HolderScore> = new Map();
  
  constructor(heliusApiKey: string) {
    this.analyzer = new HolderScoreAnalyzer(heliusApiKey);
  }
  
  async scoreToken(
    token: PumpfunToken,
    bondingCurveProgress: number
  ): Promise<HolderScore | null> {
    // Check cache
    const cacheKey = `${token.mint}_${Math.floor(bondingCurveProgress)}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < 300000) { // 5 min cache
        return cached;
      }
    }
    
    // Score only in activation window
    if (bondingCurveProgress < 10 || bondingCurveProgress > 25) {
      return null;
    }
    
    try {
      const score = await this.analyzer.analyzeToken(
        token.mint,
        bondingCurveProgress
      );
      
      this.cache.set(cacheKey, score);
      return score;
    } catch (error) {
      console.error(`Holder scoring failed for ${token.mint}:`, error);
      return null;
    }
  }
}
```

## Risk Detection Patterns

### Red Flags (Automatic Disqualification)
1. **Sybil Attack Pattern**
   - >20% of holders created within same hour
   - Sequential wallet addresses
   - Identical transaction amounts

2. **Wash Trading**
   - Circular token flows between wallets
   - Rapid buy/sell patterns
   - Price manipulation attempts

3. **Honeypot Indicators**
   - Only buys, no successful sells
   - Abnormal slippage patterns
   - Locked liquidity with no timelock

### Yellow Flags (Score Penalties)
1. **Concentration Risk**
   - Top 10 holders own >40%
   - Rapid accumulation by single entities
   - Hidden connected wallets

2. **Artificial Activity**
   - Bot-like transaction timing
   - Uniform buy amounts
   - Low wallet diversity

## Monitoring and Alerts
```typescript
interface HolderAlert {
  type: 'RED_FLAG' | 'YELLOW_FLAG' | 'POSITIVE_SIGNAL';
  severity: number; // 1-10
  message: string;
  data: any;
}

class HolderMonitor {
  async checkAlerts(
    token: string,
    score: HolderScore
  ): Promise<HolderAlert[]> {
    const alerts: HolderAlert[] = [];
    
    // Check for red flags
    if (score.distribution < 30) {
      alerts.push({
        type: 'RED_FLAG',
        severity: 9,
        message: 'Extreme concentration risk detected',
        data: { score: score.distribution }
      });
    }
    
    // Check for positive signals
    if (score.quality > 90) {
      alerts.push({
        type: 'POSITIVE_SIGNAL',
        severity: 8,
        message: 'High-quality holder base detected',
        data: { score: score.quality }
      });
    }
    
    return alerts;
  }
}
```

## Database Schema
```sql
CREATE TABLE holder_scores (
  id SERIAL PRIMARY KEY,
  token_mint VARCHAR(44) NOT NULL,
  bonding_curve_progress DECIMAL(5,2) NOT NULL,
  total_score INTEGER NOT NULL,
  distribution_score INTEGER NOT NULL,
  quality_score INTEGER NOT NULL,
  activity_score INTEGER NOT NULL,
  holder_count INTEGER NOT NULL,
  gini_coefficient DECIMAL(4,3),
  top_10_concentration DECIMAL(5,2),
  avg_wallet_age_days DECIMAL(8,2),
  bot_ratio DECIMAL(4,3),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_token_progress (token_mint, bonding_curve_progress),
  INDEX idx_score_time (total_score, created_at DESC)
);

CREATE TABLE holder_alerts (
  id SERIAL PRIMARY KEY,
  token_mint VARCHAR(44) NOT NULL,
  alert_type VARCHAR(20) NOT NULL,
  severity INTEGER NOT NULL,
  message TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_token_alerts (token_mint, created_at DESC)
);
```

## Performance Optimization
- Cache holder data for 5 minutes
- Batch Helius API calls (max 100 addresses per call)
- Use parallel processing for wallet analysis
- Implement progressive scoring (basic → detailed)
- Store historical scores for trend analysis

## Future Enhancements
1. Machine learning for bot detection
2. Social graph analysis integration
3. Cross-chain wallet history
4. Real-time holder tracking
5. Predictive holder behavior modeling