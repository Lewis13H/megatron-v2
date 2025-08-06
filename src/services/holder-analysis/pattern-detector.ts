export interface WalletPatternData {
  address: string;
  createdAt?: Date;
  lastActive?: Date;
  transactionCount: number;
  buyCount?: number;
  sellCount?: number;
  solBalance: number;
  walletAge: number;
  signatures?: any[];
  isBot?: boolean;
  uniqueTokensTraded?: number;
  totalVolumeUSD?: number;
  totalPnL?: number;
  winRate?: number;
  graduatedTokens?: number;
}

export interface TokenData {
  totalSupply: number;
  holderCount: number;
  createdAt: Date;
}

export class PatternDetector {
  
  // Bot detection with multiple signals
  detectBot(wallet: WalletPatternData): boolean {
    const signals = this.getBotSignals(wallet);
    const botScore = this.calculateBotScore(signals);
    
    // Threshold for bot classification (adjust based on testing)
    return botScore >= 0.6;
  }
  
  private getBotSignals(wallet: WalletPatternData): Record<string, boolean> {
    return {
      // Balance signals
      lowBalance: wallet.solBalance < 0.01,
      suspiciousBalance: this.isSuspiciousBalance(wallet.solBalance),
      
      // Age signals
      veryNewAccount: wallet.walletAge < 1,
      newAccount: wallet.walletAge < 7,
      
      // Activity signals
      highFrequency: wallet.transactionCount > 1000 && wallet.walletAge < 30,
      lowActivity: wallet.transactionCount < 5 && wallet.walletAge > 30,
      
      // Pattern signals
      roundNumbers: this.hasRoundNumberPatterns(wallet),
      timingPatterns: this.hasRegularTimingPatterns(wallet.signatures),
      
      // Behavioral signals
      onlyBuys: (wallet.buyCount || 0) > 0 && wallet.sellCount === 0,
      identicalTrades: this.hasIdenticalTrades(wallet.signatures),
      
      // MEV/Sandwich bot detection
      mevActivity: this.detectMEVActivity(wallet.signatures),
      sandwichPattern: this.detectSandwichPattern(wallet.signatures),
      
      // Sniper bot detection
      sniperTiming: this.detectSniperTiming(wallet),
      multipleNewTokens: this.detectMultipleNewTokens(wallet)
    };
  }
  
  private calculateBotScore(signals: Record<string, boolean>): number {
    // Weight different signals
    const weights: Record<string, number> = {
      lowBalance: 0.15,
      suspiciousBalance: 0.10,
      veryNewAccount: 0.20,
      newAccount: 0.10,
      highFrequency: 0.15,
      lowActivity: 0.05,
      roundNumbers: 0.15,
      timingPatterns: 0.20,
      onlyBuys: 0.10,
      identicalTrades: 0.15,
      mevActivity: 0.30,
      sandwichPattern: 0.25,
      sniperTiming: 0.25,
      multipleNewTokens: 0.20
    };
    
    let totalScore = 0;
    let totalWeight = 0;
    
    for (const [signal, isPresent] of Object.entries(signals)) {
      if (isPresent && weights[signal]) {
        totalScore += weights[signal];
      }
      if (weights[signal]) {
        totalWeight += weights[signal];
      }
    }
    
    return totalWeight > 0 ? totalScore / totalWeight : 0;
  }
  
  private isSuspiciousBalance(balance: number): boolean {
    // Common bot funding amounts
    const suspiciousAmounts = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
    return suspiciousAmounts.includes(balance);
  }
  
  private hasRoundNumberPatterns(wallet: WalletPatternData): boolean {
    if (!wallet.transactionCount) return false;
    
    // Check if transaction count is suspiciously round
    const roundNumbers = [10, 20, 50, 100, 200, 500, 1000];
    if (roundNumbers.includes(wallet.transactionCount)) {
      return true;
    }
    
    // Check if buy/sell counts are identical or very close
    if (wallet.buyCount && wallet.sellCount) {
      const ratio = wallet.buyCount / wallet.sellCount;
      if (ratio > 0.95 && ratio < 1.05) {
        return true;
      }
    }
    
    return false;
  }
  
  private hasRegularTimingPatterns(signatures?: any[]): boolean {
    if (!signatures || signatures.length < 10) return false;
    
    // Calculate time differences between transactions
    const timeDiffs: number[] = [];
    for (let i = 1; i < Math.min(50, signatures.length); i++) {
      if (signatures[i].blockTime && signatures[i-1].blockTime) {
        timeDiffs.push(signatures[i].blockTime - signatures[i-1].blockTime);
      }
    }
    
    if (timeDiffs.length < 5) return false;
    
    // Check for regular intervals (bot-like behavior)
    const avgDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
    const variance = timeDiffs.reduce((sum, diff) => 
      sum + Math.pow(diff - avgDiff, 2), 0
    ) / timeDiffs.length;
    
    const coefficientOfVariation = Math.sqrt(variance) / avgDiff;
    
    // Low coefficient of variation indicates regular timing
    return coefficientOfVariation < 0.2;
  }
  
  private hasIdenticalTrades(signatures?: any[]): boolean {
    if (!signatures || signatures.length < 5) return false;
    
    // Look for repeated transaction patterns
    const amounts = new Map<string, number>();
    
    for (const sig of signatures.slice(0, 50)) {
      if (sig.memo) {
        const amount = sig.memo.match(/\d+\.?\d*/)?.[0];
        if (amount) {
          amounts.set(amount, (amounts.get(amount) || 0) + 1);
        }
      }
    }
    
    // If any amount appears too frequently, likely a bot
    for (const count of amounts.values()) {
      if (count > signatures.length * 0.3) {
        return true;
      }
    }
    
    return false;
  }
  
  private detectMEVActivity(signatures?: any[]): boolean {
    if (!signatures || signatures.length < 20) return false;
    
    // Look for sandwich attack patterns
    let mevPatterns = 0;
    
    for (let i = 1; i < signatures.length - 1; i++) {
      const prev = signatures[i - 1];
      const curr = signatures[i];
      const next = signatures[i + 1];
      
      // MEV bots typically have very close timestamps
      if (prev.blockTime && curr.blockTime && next.blockTime) {
        const timeDiff1 = curr.blockTime - prev.blockTime;
        const timeDiff2 = next.blockTime - curr.blockTime;
        
        // Transactions within 2 seconds of each other
        if (timeDiff1 < 2 && timeDiff2 < 2) {
          mevPatterns++;
        }
      }
    }
    
    return mevPatterns > signatures.length * 0.1;
  }
  
  private detectSandwichPattern(signatures?: any[]): boolean {
    if (!signatures || signatures.length < 10) return false;
    
    // Look for buy-sell-buy or sell-buy-sell patterns
    let sandwichCount = 0;
    
    for (let i = 2; i < Math.min(50, signatures.length); i++) {
      const sig1 = signatures[i - 2];
      const sig2 = signatures[i - 1];
      const sig3 = signatures[i];
      
      // Simple pattern detection based on memos
      if (sig1.memo && sig2.memo && sig3.memo) {
        const isBuy = (memo: string) => memo.toLowerCase().includes('buy');
        const isSell = (memo: string) => memo.toLowerCase().includes('sell');
        
        if ((isBuy(sig1.memo) && isSell(sig2.memo) && isBuy(sig3.memo)) ||
            (isSell(sig1.memo) && isBuy(sig2.memo) && isSell(sig3.memo))) {
          sandwichCount++;
        }
      }
    }
    
    return sandwichCount > 2;
  }
  
  private detectSniperTiming(wallet: WalletPatternData): boolean {
    if (!wallet.createdAt || !wallet.signatures || wallet.signatures.length === 0) {
      return false;
    }
    
    // Sniper bots buy within seconds of token launch
    const firstTx = wallet.signatures[wallet.signatures.length - 1];
    if (firstTx && firstTx.blockTime) {
      const walletAge = (Date.now() - wallet.createdAt.getTime()) / 1000; // in seconds
      const firstTxAge = (Date.now() - firstTx.blockTime * 1000) / 1000;
      
      // If wallet is new and immediately trading, likely a sniper
      if (walletAge < 3600 && firstTxAge < 60) {
        return true;
      }
    }
    
    return false;
  }
  
  private detectMultipleNewTokens(wallet: WalletPatternData): boolean {
    // If wallet trades many tokens shortly after they launch
    if (wallet.uniqueTokensTraded && wallet.walletAge < 30) {
      const tokensPerDay = wallet.uniqueTokensTraded / Math.max(1, wallet.walletAge);
      return tokensPerDay > 5; // More than 5 new tokens per day is suspicious
    }
    return false;
  }
  
  // Smart money detection
  detectSmartMoney(wallet: WalletPatternData): boolean {
    const criteria = this.getSmartMoneyCriteria(wallet);
    const smartScore = this.calculateSmartMoneyScore(criteria);
    
    // Threshold for smart money classification
    return smartScore >= 0.6;
  }
  
  private getSmartMoneyCriteria(wallet: WalletPatternData): Record<string, boolean> {
    return {
      // Experience indicators
      aged: wallet.walletAge > 180,
      experienced: wallet.walletAge > 90,
      
      // Success indicators
      profitable: wallet.totalPnL ? wallet.totalPnL > 0 : false,
      highWinRate: wallet.winRate ? wallet.winRate > 0.6 : false,
      consistent: wallet.winRate ? wallet.winRate > 0.5 && wallet.transactionCount > 100 : false,
      
      // Volume indicators
      highVolume: wallet.totalVolumeUSD ? wallet.totalVolumeUSD > 100000 : false,
      mediumVolume: wallet.totalVolumeUSD ? wallet.totalVolumeUSD > 10000 : false,
      
      // Portfolio indicators
      diverse: wallet.uniqueTokensTraded ? wallet.uniqueTokensTraded > 50 : false,
      graduationCatcher: wallet.graduatedTokens ? wallet.graduatedTokens > 3 : false,
      
      // Capital indicators
      wellFunded: wallet.solBalance > 10,
      veryWellFunded: wallet.solBalance > 100,
      
      // Behavior indicators
      activeTrader: wallet.transactionCount > 500,
      balancedTrading: this.hasBalancedTrading(wallet)
    };
  }
  
  private calculateSmartMoneyScore(criteria: Record<string, boolean>): number {
    const weights: Record<string, number> = {
      aged: 0.15,
      experienced: 0.10,
      profitable: 0.20,
      highWinRate: 0.25,
      consistent: 0.20,
      highVolume: 0.15,
      mediumVolume: 0.10,
      diverse: 0.15,
      graduationCatcher: 0.25,
      wellFunded: 0.10,
      veryWellFunded: 0.15,
      activeTrader: 0.10,
      balancedTrading: 0.15
    };
    
    let totalScore = 0;
    let totalWeight = 0;
    
    for (const [criterion, meets] of Object.entries(criteria)) {
      if (meets && weights[criterion]) {
        totalScore += weights[criterion];
      }
      if (weights[criterion]) {
        totalWeight += weights[criterion];
      }
    }
    
    return totalWeight > 0 ? totalScore / totalWeight : 0;
  }
  
  private hasBalancedTrading(wallet: WalletPatternData): boolean {
    if (!wallet.buyCount || !wallet.sellCount) return false;
    
    const total = wallet.buyCount + wallet.sellCount;
    const buyRatio = wallet.buyCount / total;
    
    // Balanced trading between 30-70% buys
    return buyRatio > 0.3 && buyRatio < 0.7;
  }
  
  // Calculate wallet risk score
  calculateWalletRisk(wallet: WalletPatternData & { isBot?: boolean }): number {
    let riskScore = 0;
    
    // Bot risk (0-20)
    if (wallet.isBot) {
      riskScore += 20;
    }
    
    // New wallet risk (0-20)
    if (wallet.walletAge < 1) {
      riskScore += 20;
    } else if (wallet.walletAge < 7) {
      riskScore += 15;
    } else if (wallet.walletAge < 30) {
      riskScore += 10;
    } else if (wallet.walletAge < 90) {
      riskScore += 5;
    }
    
    // Low balance risk (0-20)
    if (wallet.solBalance < 0.01) {
      riskScore += 20;
    } else if (wallet.solBalance < 0.1) {
      riskScore += 15;
    } else if (wallet.solBalance < 1) {
      riskScore += 10;
    } else if (wallet.solBalance < 10) {
      riskScore += 5;
    }
    
    // Low activity risk (0-20)
    if (wallet.transactionCount < 5) {
      riskScore += 20;
    } else if (wallet.transactionCount < 20) {
      riskScore += 15;
    } else if (wallet.transactionCount < 50) {
      riskScore += 10;
    } else if (wallet.transactionCount < 100) {
      riskScore += 5;
    }
    
    // Suspicious patterns (0-20)
    if (this.hasRoundNumberPatterns(wallet)) {
      riskScore += 10;
    }
    if (this.hasRegularTimingPatterns(wallet.signatures)) {
      riskScore += 10;
    }
    
    return Math.min(100, riskScore);
  }
  
  // Detect MEV bot specifically
  detectMEVBot(wallet: WalletPatternData): boolean {
    if (!wallet.signatures || wallet.signatures.length < 100) {
      return false;
    }
    
    // MEV bots have specific characteristics
    const highFrequency = wallet.transactionCount > 10000;
    const recentActivity = wallet.walletAge < 90;
    const mevPatterns = this.detectMEVActivity(wallet.signatures);
    const sandwichPatterns = this.detectSandwichPattern(wallet.signatures);
    
    // Check for arbitrage patterns
    const arbitragePatterns = this.detectArbitragePatterns(wallet.signatures);
    
    return (highFrequency && recentActivity) || 
           mevPatterns || 
           sandwichPatterns || 
           arbitragePatterns;
  }
  
  private detectArbitragePatterns(signatures?: any[]): boolean {
    if (!signatures || signatures.length < 20) return false;
    
    // Arbitrage bots typically have very rapid successive transactions
    let rapidSequences = 0;
    
    for (let i = 1; i < Math.min(100, signatures.length); i++) {
      if (signatures[i].blockTime && signatures[i-1].blockTime) {
        const timeDiff = signatures[i].blockTime - signatures[i-1].blockTime;
        if (timeDiff < 1) { // Less than 1 second apart
          rapidSequences++;
        }
      }
    }
    
    // If more than 20% of transactions are rapid, likely arbitrage bot
    return rapidSequences > signatures.length * 0.2;
  }
  
  // Detect pump and dump participants
  detectPumpAndDumpRisk(wallet: WalletPatternData, tokenData?: TokenData): number {
    let pumpDumpScore = 0;
    
    // Early buyer who hasn't sold
    if (wallet.walletAge < 1 && (wallet.buyCount || 0) > 0 && wallet.sellCount === 0) {
      pumpDumpScore += 30;
    }
    
    // Large holder in new token
    if (tokenData && wallet.createdAt) {
      const tokenAge = (Date.now() - tokenData.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (tokenAge < 1) {
        pumpDumpScore += 20;
      }
    }
    
    // Suspicious funding pattern
    if (this.isSuspiciousBalance(wallet.solBalance)) {
      pumpDumpScore += 20;
    }
    
    // Connected to other suspicious wallets
    if (wallet.signatures && this.hasIdenticalTrades(wallet.signatures)) {
      pumpDumpScore += 30;
    }
    
    return Math.min(100, pumpDumpScore);
  }
  
  // Detect diamond hands (long-term holders)
  detectDiamondHands(wallet: WalletPatternData): boolean {
    // Diamond hands criteria
    const isAged = wallet.walletAge > 90;
    const hasNotSold = wallet.sellCount === 0 || 
                       (wallet.buyCount && wallet.sellCount && wallet.buyCount > wallet.sellCount * 5);
    const isWellFunded = wallet.solBalance > 1;
    const isActive = wallet.transactionCount > 50;
    
    return !!(isAged && hasNotSold && isWellFunded && isActive);
  }
  
  // Detect paper hands (quick sellers)
  detectPaperHands(wallet: WalletPatternData): boolean {
    if (!wallet.buyCount || !wallet.sellCount) return false;
    
    // Paper hands criteria
    const sellsMoreThanBuys = wallet.sellCount > wallet.buyCount * 1.5;
    const quickTrader = wallet.walletAge < 30 && wallet.transactionCount > 20;
    const lowBalance = wallet.solBalance < 0.1;
    
    return sellsMoreThanBuys || (quickTrader && lowBalance);
  }
}