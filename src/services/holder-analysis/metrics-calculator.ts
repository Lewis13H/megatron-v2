import { EnrichedHolder } from './holder-analysis-service';

export interface DistributionMetrics {
  uniqueHolders: number;
  giniCoefficient: number;
  herfindahlIndex: number;
  theilIndex: number;
  shannonEntropy: number;
  top1Percent: number;
  top10Percent: number;
  top100Holders: number;
  medianBalance: number;
  averageBalance: number;
  standardDeviation: number;
  coefficientOfVariation: number;
}

export interface QualityMetrics {
  botCount: number;
  botRatio: number;
  smartMoneyCount: number;
  smartMoneyRatio: number;
  diamondHandsCount: number;
  diamondHandRatio: number;
  whaleCount: number;
  averageWalletAge: number;
  medianWalletAge: number;
  verifiedWallets: number;
  highRiskWallets: number;
  averageRiskScore: number;
}

export interface ActivityMetrics {
  activeHolders1h: number;
  activeHolders24h: number;
  newHolders24h: number;
  buyersCount: number;
  sellersCount: number;
  averageTransactionCount: number;
  buyerSellerRatio: number;
  velocityScore: number;
  organicGrowthScore: number;
  tradingIntensity: number;
}

export interface RiskMetrics {
  concentrationRisk: number;
  botRisk: number;
  rugRisk: number;
  washTradingRisk: number;
  liquidityRisk: number;
  volatilityRisk: number;
  overall: number;
}

export class MetricsCalculator {
  
  calculateDistributionMetrics(holders: EnrichedHolder[]): DistributionMetrics {
    if (holders.length === 0) {
      return this.getEmptyDistributionMetrics();
    }

    // Sort by token balance descending
    const sorted = holders
      .filter(h => h.tokenBalance && h.tokenBalance > 0)
      .sort((a, b) => b.tokenBalance - a.tokenBalance);

    if (sorted.length === 0) {
      return this.getEmptyDistributionMetrics();
    }

    const totalSupply = sorted.reduce((sum, h) => sum + h.tokenBalance, 0);
    const balances = sorted.map(h => h.tokenBalance);

    // Calculate top holder percentages
    const top1 = sorted[0] ? (sorted[0].tokenBalance / totalSupply) * 100 : 0;
    const top10Supply = sorted.slice(0, 10).reduce((sum, h) => sum + h.tokenBalance, 0);
    const top10 = (top10Supply / totalSupply) * 100;
    const top100Supply = sorted.slice(0, 100).reduce((sum, h) => sum + h.tokenBalance, 0);
    const top100 = (top100Supply / totalSupply) * 100;

    // Statistical measures
    const average = totalSupply / sorted.length;
    const median = this.calculateMedian(balances);
    const stdDev = this.calculateStandardDeviation(balances, average);
    const cv = average > 0 ? stdDev / average : 0;

    return {
      uniqueHolders: sorted.length,
      giniCoefficient: this.calculateGini(balances),
      herfindahlIndex: this.calculateHHI(sorted, totalSupply),
      theilIndex: this.calculateTheil(sorted, totalSupply),
      shannonEntropy: this.calculateEntropy(sorted, totalSupply),
      top1Percent: top1,
      top10Percent: top10,
      top100Holders: top100,
      medianBalance: median,
      averageBalance: average,
      standardDeviation: stdDev,
      coefficientOfVariation: cv
    };
  }

  private calculateGini(values: number[]): number {
    if (values.length === 0) return 0;
    
    const sorted = values.sort((a, b) => a - b);
    const n = sorted.length;
    const cumSum: number[] = [];
    let runningSum = 0;
    
    for (let i = 0; i < n; i++) {
      runningSum += sorted[i];
      cumSum.push(runningSum);
    }
    
    const totalSum = cumSum[n - 1];
    if (totalSum === 0) return 0;
    
    // Calculate area under Lorenz curve
    let area = 0;
    for (let i = 0; i < n; i++) {
      const x = (i + 1) / n;
      const y = cumSum[i] / totalSum;
      const prevY = i > 0 ? cumSum[i - 1] / totalSum : 0;
      area += (x - (i / n)) * (y + prevY) / 2;
    }
    
    // Gini = 1 - 2 * area under Lorenz curve
    const gini = 1 - 2 * area;
    return Math.max(0, Math.min(1, gini));
  }

  private calculateHHI(holders: EnrichedHolder[], total: number): number {
    if (total === 0) return 0;
    
    return holders.reduce((sum, h) => {
      const share = h.tokenBalance / total;
      return sum + (share * share * 10000); // Scale to 0-10000
    }, 0);
  }

  private calculateTheil(holders: EnrichedHolder[], total: number): number {
    if (holders.length === 0 || total === 0) return 0;
    
    const n = holders.length;
    const avgBalance = total / n;
    
    let theil = 0;
    for (const holder of holders) {
      if (holder.tokenBalance > 0) {
        const ratio = holder.tokenBalance / avgBalance;
        theil += (ratio * Math.log(ratio)) / n;
      }
    }
    
    return Math.max(0, theil);
  }

  private calculateEntropy(holders: EnrichedHolder[], total: number): number {
    if (total === 0) return 0;
    
    let entropy = 0;
    for (const holder of holders) {
      if (holder.tokenBalance > 0) {
        const p = holder.tokenBalance / total;
        entropy -= p * Math.log2(p);
      }
    }
    
    // Normalize to 0-1 range
    const maxEntropy = Math.log2(holders.length);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  calculateQualityMetrics(holders: EnrichedHolder[]): QualityMetrics {
    if (holders.length === 0) {
      return this.getEmptyQualityMetrics();
    }

    const totalHolders = holders.length;
    
    // Count different holder types
    const bots = holders.filter(h => h.isBot);
    const smartMoney = holders.filter(h => h.isSmartMoney);
    const diamondHands = holders.filter(h => 
      h.walletAge > 90 && 
      h.sellCount === 0 && 
      h.tokenBalance > 0
    );
    const whales = holders.filter(h => h.solBalance > 100);
    const verified = holders.filter(h => h.isVerified);
    const highRisk = holders.filter(h => h.riskScore > 70);
    
    // Calculate age metrics
    const ages = holders.map(h => h.walletAge).filter(age => age > 0);
    const avgAge = ages.length > 0 ? 
      ages.reduce((sum, age) => sum + age, 0) / ages.length : 0;
    const medianAge = this.calculateMedian(ages);
    
    // Calculate average risk
    const avgRisk = holders.reduce((sum, h) => sum + h.riskScore, 0) / totalHolders;

    return {
      botCount: bots.length,
      botRatio: bots.length / totalHolders,
      smartMoneyCount: smartMoney.length,
      smartMoneyRatio: smartMoney.length / totalHolders,
      diamondHandsCount: diamondHands.length,
      diamondHandRatio: diamondHands.length / totalHolders,
      whaleCount: whales.length,
      averageWalletAge: avgAge,
      medianWalletAge: medianAge,
      verifiedWallets: verified.length,
      highRiskWallets: highRisk.length,
      averageRiskScore: avgRisk
    };
  }

  calculateActivityMetrics(holders: EnrichedHolder[]): ActivityMetrics {
    if (holders.length === 0) {
      return this.getEmptyActivityMetrics();
    }

    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const oneDayAgo = now - 86400000;
    
    // Count active holders by time window
    const activeLastHour = holders.filter(h => 
      h.lastActive && h.lastActive.getTime() > oneHourAgo
    );
    const activeLastDay = holders.filter(h => 
      h.lastActive && h.lastActive.getTime() > oneDayAgo
    );
    
    // Count new holders
    const newHolders = holders.filter(h => 
      h.firstTransaction && h.firstTransaction.getTime() > oneDayAgo
    );
    
    // Count buyers vs sellers
    const buyers = holders.filter(h => h.buyCount > 0);
    const sellers = holders.filter(h => h.sellCount > 0);
    const buyerSellerRatio = sellers.length > 0 ? buyers.length / sellers.length : buyers.length;
    
    // Calculate average transaction count
    const avgTxCount = holders.reduce((sum, h) => sum + h.transactionCount, 0) / holders.length;
    
    // Calculate velocity score (0-1)
    const velocityScore = this.calculateVelocityScore(holders);
    
    // Calculate organic growth score (0-1)
    const organicGrowthScore = this.calculateOrganicGrowthScore(holders);
    
    // Calculate trading intensity
    const tradingIntensity = this.calculateTradingIntensity(holders);

    return {
      activeHolders1h: activeLastHour.length,
      activeHolders24h: activeLastDay.length,
      newHolders24h: newHolders.length,
      buyersCount: buyers.length,
      sellersCount: sellers.length,
      averageTransactionCount: avgTxCount,
      buyerSellerRatio,
      velocityScore,
      organicGrowthScore,
      tradingIntensity
    };
  }

  private calculateVelocityScore(holders: EnrichedHolder[]): number {
    // Velocity based on transaction frequency and recency
    let totalScore = 0;
    const now = Date.now();
    
    for (const holder of holders) {
      if (holder.lastActive) {
        const daysSinceActive = (now - holder.lastActive.getTime()) / (1000 * 60 * 60 * 24);
        const recencyScore = Math.max(0, 1 - (daysSinceActive / 30)); // Decay over 30 days
        const frequencyScore = Math.min(1, holder.transactionCount / 100); // Cap at 100 tx
        totalScore += (recencyScore * 0.7 + frequencyScore * 0.3);
      }
    }
    
    return holders.length > 0 ? totalScore / holders.length : 0;
  }

  private calculateOrganicGrowthScore(holders: EnrichedHolder[]): number {
    // Organic growth based on diverse wallet ages and transaction patterns
    const ageDistribution = this.getAgeDistribution(holders);
    const sizeDistribution = this.getBalanceDistribution(holders);
    
    // Good organic growth has diverse ages and sizes
    const ageDiversity = this.calculateDiversityScore(ageDistribution);
    const sizeDiversity = this.calculateDiversityScore(sizeDistribution);
    
    // Check for suspicious patterns
    const suspiciousPatterns = this.detectSuspiciousPatterns(holders);
    
    const baseScore = (ageDiversity * 0.5 + sizeDiversity * 0.5);
    const penalty = suspiciousPatterns * 0.3;
    
    return Math.max(0, baseScore - penalty);
  }

  private calculateTradingIntensity(holders: EnrichedHolder[]): number {
    // Trading intensity based on buy/sell activity
    const activeTraders = holders.filter(h => 
      h.buyCount > 1 || h.sellCount > 1
    );
    
    if (activeTraders.length === 0) return 0;
    
    const avgBuys = activeTraders.reduce((sum, h) => sum + h.buyCount, 0) / activeTraders.length;
    const avgSells = activeTraders.reduce((sum, h) => sum + h.sellCount, 0) / activeTraders.length;
    
    // Normalize to 0-1 scale
    const buyIntensity = Math.min(1, avgBuys / 20);
    const sellIntensity = Math.min(1, avgSells / 20);
    
    return (buyIntensity + sellIntensity) / 2;
  }

  calculateRiskMetrics(holders: EnrichedHolder[], distribution: DistributionMetrics): RiskMetrics {
    // Concentration risk (0-100)
    let concentrationRisk = 0;
    if (distribution.giniCoefficient > 0.9) concentrationRisk = 100;
    else if (distribution.giniCoefficient > 0.8) concentrationRisk = 80;
    else if (distribution.giniCoefficient > 0.7) concentrationRisk = 60;
    else if (distribution.giniCoefficient > 0.6) concentrationRisk = 40;
    else concentrationRisk = distribution.giniCoefficient * 40;
    
    // Bot risk (0-100)
    const botRatio = holders.filter(h => h.isBot).length / holders.length;
    const botRisk = Math.min(100, botRatio * 200);
    
    // Rug risk based on concentration and new wallets
    const newWallets = holders.filter(h => h.walletAge < 7);
    const newWalletRatio = newWallets.length / holders.length;
    const rugRisk = Math.min(100, 
      (distribution.top1Percent * 2) + 
      (newWalletRatio * 100) + 
      (distribution.giniCoefficient * 50)
    );
    
    // Wash trading risk
    const washTradingRisk = this.detectWashTradingRisk(holders);
    
    // Liquidity risk based on holder count and distribution
    let liquidityRisk = 0;
    if (holders.length < 10) liquidityRisk = 90;
    else if (holders.length < 50) liquidityRisk = 70;
    else if (holders.length < 100) liquidityRisk = 50;
    else if (holders.length < 500) liquidityRisk = 30;
    else liquidityRisk = 10;
    
    // Volatility risk based on trading patterns
    const volatilityRisk = this.calculateVolatilityRisk(holders);
    
    // Overall risk is weighted average
    const overall = (
      concentrationRisk * 0.25 +
      botRisk * 0.20 +
      rugRisk * 0.25 +
      washTradingRisk * 0.10 +
      liquidityRisk * 0.10 +
      volatilityRisk * 0.10
    );

    return {
      concentrationRisk,
      botRisk,
      rugRisk,
      washTradingRisk,
      liquidityRisk,
      volatilityRisk,
      overall: Math.min(100, overall)
    };
  }

  private detectWashTradingRisk(holders: EnrichedHolder[]): number {
    // Look for suspicious trading patterns
    let suspiciousPatterns = 0;
    
    // Check for wallets with identical transaction counts
    const txCounts = new Map<number, number>();
    holders.forEach(h => {
      const count = h.transactionCount;
      txCounts.set(count, (txCounts.get(count) || 0) + 1);
    });
    
    // If many wallets have same tx count, suspicious
    for (const [count, frequency] of txCounts) {
      if (count > 10 && frequency > holders.length * 0.1) {
        suspiciousPatterns += 20;
      }
    }
    
    // Check for wallets created at similar times
    const creationTimes = holders.map(h => 
      h.createdAt ? Math.floor(h.createdAt.getTime() / 3600000) : 0 // Hour precision
    );
    const timeGroups = new Map<number, number>();
    creationTimes.forEach(time => {
      if (time > 0) {
        timeGroups.set(time, (timeGroups.get(time) || 0) + 1);
      }
    });
    
    for (const [time, count] of timeGroups) {
      if (count > holders.length * 0.2) {
        suspiciousPatterns += 30;
      }
    }
    
    // Check for circular trading (similar buy/sell counts)
    const balancedTraders = holders.filter(h => 
      h.buyCount > 5 && 
      h.sellCount > 5 && 
      Math.abs(h.buyCount - h.sellCount) < 2
    );
    if (balancedTraders.length > holders.length * 0.3) {
      suspiciousPatterns += 30;
    }
    
    return Math.min(100, suspiciousPatterns);
  }

  private calculateVolatilityRisk(holders: EnrichedHolder[]): number {
    // Volatility based on holder stability
    const recentSellers = holders.filter(h => {
      if (!h.lastActive) return false;
      const hoursSinceActive = (Date.now() - h.lastActive.getTime()) / 3600000;
      return hoursSinceActive < 24 && h.sellCount > 0;
    });
    
    const sellerRatio = recentSellers.length / holders.length;
    const avgSellPressure = recentSellers.reduce((sum, h) => sum + h.sellCount, 0) / 
      Math.max(1, recentSellers.length);
    
    const volatilityScore = (sellerRatio * 50) + Math.min(50, avgSellPressure * 5);
    return Math.min(100, volatilityScore);
  }

  private getAgeDistribution(holders: EnrichedHolder[]): Map<string, number> {
    const distribution = new Map<string, number>();
    const buckets = ['0-7', '7-30', '30-90', '90-180', '180+'];
    
    buckets.forEach(bucket => distribution.set(bucket, 0));
    
    holders.forEach(h => {
      const age = h.walletAge;
      if (age <= 7) distribution.set('0-7', distribution.get('0-7')! + 1);
      else if (age <= 30) distribution.set('7-30', distribution.get('7-30')! + 1);
      else if (age <= 90) distribution.set('30-90', distribution.get('30-90')! + 1);
      else if (age <= 180) distribution.set('90-180', distribution.get('90-180')! + 1);
      else distribution.set('180+', distribution.get('180+')! + 1);
    });
    
    return distribution;
  }

  private getBalanceDistribution(holders: EnrichedHolder[]): Map<string, number> {
    const distribution = new Map<string, number>();
    const buckets = ['micro', 'small', 'medium', 'large', 'whale'];
    
    buckets.forEach(bucket => distribution.set(bucket, 0));
    
    holders.forEach(h => {
      const balance = h.tokenBalance;
      const totalSupply = holders.reduce((sum, h) => sum + h.tokenBalance, 0);
      const percentage = (balance / totalSupply) * 100;
      
      if (percentage < 0.01) distribution.set('micro', distribution.get('micro')! + 1);
      else if (percentage < 0.1) distribution.set('small', distribution.get('small')! + 1);
      else if (percentage < 1) distribution.set('medium', distribution.get('medium')! + 1);
      else if (percentage < 5) distribution.set('large', distribution.get('large')! + 1);
      else distribution.set('whale', distribution.get('whale')! + 1);
    });
    
    return distribution;
  }

  private calculateDiversityScore(distribution: Map<string, number>): number {
    const total = Array.from(distribution.values()).reduce((sum, val) => sum + val, 0);
    if (total === 0) return 0;
    
    let entropy = 0;
    for (const count of distribution.values()) {
      if (count > 0) {
        const p = count / total;
        entropy -= p * Math.log2(p);
      }
    }
    
    const maxEntropy = Math.log2(distribution.size);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  private detectSuspiciousPatterns(holders: EnrichedHolder[]): number {
    let suspicionScore = 0;
    
    // Check for too many wallets with identical balances
    const balanceGroups = new Map<number, number>();
    holders.forEach(h => {
      const roundedBalance = Math.floor(h.tokenBalance);
      balanceGroups.set(roundedBalance, (balanceGroups.get(roundedBalance) || 0) + 1);
    });
    
    for (const [balance, count] of balanceGroups) {
      if (balance > 0 && count > holders.length * 0.1) {
        suspicionScore += 0.3;
      }
    }
    
    // Check for wallets with no transaction history
    const ghostWallets = holders.filter(h => h.transactionCount === 0);
    if (ghostWallets.length > holders.length * 0.3) {
      suspicionScore += 0.4;
    }
    
    return Math.min(1, suspicionScore);
  }

  private calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;
    
    const sorted = values.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    } else {
      return sorted[mid];
    }
  }

  private calculateStandardDeviation(values: number[], mean: number): number {
    if (values.length === 0) return 0;
    
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;
    
    return Math.sqrt(avgSquaredDiff);
  }

  private getEmptyDistributionMetrics(): DistributionMetrics {
    return {
      uniqueHolders: 0,
      giniCoefficient: 0,
      herfindahlIndex: 0,
      theilIndex: 0,
      shannonEntropy: 0,
      top1Percent: 0,
      top10Percent: 0,
      top100Holders: 0,
      medianBalance: 0,
      averageBalance: 0,
      standardDeviation: 0,
      coefficientOfVariation: 0
    };
  }

  private getEmptyQualityMetrics(): QualityMetrics {
    return {
      botCount: 0,
      botRatio: 0,
      smartMoneyCount: 0,
      smartMoneyRatio: 0,
      diamondHandsCount: 0,
      diamondHandRatio: 0,
      whaleCount: 0,
      averageWalletAge: 0,
      medianWalletAge: 0,
      verifiedWallets: 0,
      highRiskWallets: 0,
      averageRiskScore: 0
    };
  }

  private getEmptyActivityMetrics(): ActivityMetrics {
    return {
      activeHolders1h: 0,
      activeHolders24h: 0,
      newHolders24h: 0,
      buyersCount: 0,
      sellersCount: 0,
      averageTransactionCount: 0,
      buyerSellerRatio: 0,
      velocityScore: 0,
      organicGrowthScore: 0,
      tradingIntensity: 0
    };
  }
}