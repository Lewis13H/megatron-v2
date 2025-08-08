import { walletTrackerService } from './wallet-tracker-service';
import { transactionFetcher } from './transaction-fetcher';
import {
  WalletTrader,
  WalletTrade,
  WalletPosition,
  TransactionData,
  WalletMetrics,
  PnLCalculation,
  WalletClassification
} from './types';

export class WalletProfileExtractor {
  
  /**
   * Extract and build wallet profile from transactions
   */
  async extractWalletProfile(
    walletAddress: string,
    transactions: TransactionData[]
  ): Promise<WalletTrader> {
    console.log(`Extracting profile for wallet ${walletAddress}...`);
    
    // Get wallet's transactions
    const walletTxs = transactions.filter(tx => tx.wallet === walletAddress);
    
    if (walletTxs.length === 0) {
      // Create minimal profile
      return await walletTrackerService.createOrUpdateWallet({
        wallet_address: walletAddress,
        wallet_type: 'normal',
        first_seen_at: new Date(),
        last_activity_at: new Date(),
        total_trades: 0,
        trader_score: 0
      });
    }
    
    // Calculate metrics
    const metrics = await this.calculateWalletMetrics(walletAddress, walletTxs);
    
    // Classify wallet type
    const classification = this.classifyWallet(walletTxs, metrics);
    
    // Create or update wallet profile
    const wallet = await walletTrackerService.createOrUpdateWallet({
      wallet_address: walletAddress,
      wallet_type: classification.wallet_type,
      first_seen_at: this.getFirstSeenDate(walletTxs),
      last_activity_at: this.getLastActivityDate(walletTxs),
      total_trades: walletTxs.length,
      graduated_tokens_traded: metrics.graduated_tokens_count,
      total_pnl_sol: metrics.total_pnl_sol,
      total_pnl_usd: metrics.total_pnl_usd,
      win_rate: metrics.win_rate,
      avg_hold_time_minutes: Math.round(metrics.avg_hold_time_minutes),
      avg_return_multiple: metrics.avg_return_multiple,
      reputation_score: this.calculateReputationScore(metrics, classification),
      trader_score: 0, // Will be calculated later in scoring phase
      score_decay_factor: 1.0,
      days_inactive: 0,
      suspicious_activity_count: this.detectSuspiciousActivity(walletTxs),
      metadata: {
        classification_confidence: classification.confidence,
        classification_reasoning: classification.reasoning
      }
    });
    
    return wallet;
  }

  /**
   * Extract profiles for multiple wallets
   */
  async extractMultipleProfiles(
    walletAddresses: Set<string>,
    tokenTransactions: Map<string, TransactionData[]>
  ): Promise<Map<string, WalletTrader>> {
    const profiles = new Map<string, WalletTrader>();
    
    console.log(`Extracting profiles for ${walletAddresses.size} wallets...`);
    
    // Process in batches
    const walletsArray = Array.from(walletAddresses);
    const batchSize = 50;
    
    for (let i = 0; i < walletsArray.length; i += batchSize) {
      const batch = walletsArray.slice(i, i + batchSize);
      
      console.log(`Processing wallet batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(walletsArray.length / batchSize)}`);
      
      await Promise.all(
        batch.map(async (walletAddress) => {
          // Collect all transactions for this wallet across all tokens
          const walletTransactions: TransactionData[] = [];
          
          for (const [tokenMint, txs] of tokenTransactions) {
            const walletTxs = txs.filter(tx => tx.wallet === walletAddress);
            walletTransactions.push(...walletTxs);
          }
          
          if (walletTransactions.length > 0) {
            const profile = await this.extractWalletProfile(walletAddress, walletTransactions);
            profiles.set(walletAddress, profile);
          }
        })
      );
    }
    
    console.log(`Extracted ${profiles.size} wallet profiles`);
    return profiles;
  }

  /**
   * Calculate wallet metrics from transactions
   */
  async calculateWalletMetrics(
    walletAddress: string,
    transactions: TransactionData[]
  ): Promise<WalletMetrics> {
    // Group transactions by token
    const tokenGroups = new Map<string, TransactionData[]>();
    
    for (const tx of transactions) {
      if (!tokenGroups.has(tx.tokenMint)) {
        tokenGroups.set(tx.tokenMint, []);
      }
      tokenGroups.get(tx.tokenMint)!.push(tx);
    }
    
    // Calculate PnL for each token
    let totalPnLSol = 0;
    let totalPnLUsd = 0;
    let winCount = 0;
    let totalCount = 0;
    let totalHoldTime = 0;
    let holdTimeCount = 0;
    let returnMultiples: number[] = [];
    
    for (const [tokenMint, tokenTxs] of tokenGroups) {
      const pnl = this.calculateTokenPnL(tokenTxs);
      
      totalPnLSol += pnl.total_pnl;
      
      // Estimate USD value (would need SOL price at time)
      totalPnLUsd += pnl.total_pnl * 150; // Placeholder SOL price
      
      if (pnl.total_pnl > 0) {
        winCount++;
      }
      totalCount++;
      
      // Calculate hold time
      const holdTime = this.calculateHoldTime(tokenTxs);
      if (holdTime > 0) {
        totalHoldTime += holdTime;
        holdTimeCount++;
      }
      
      // Calculate return multiple
      if (pnl.avg_buy_price > 0 && pnl.avg_sell_price) {
        returnMultiples.push(pnl.avg_sell_price / pnl.avg_buy_price);
      }
    }
    
    const avgReturnMultiple = returnMultiples.length > 0
      ? returnMultiples.reduce((a, b) => a + b, 0) / returnMultiples.length
      : 1;
    
    return {
      wallet_address: walletAddress,
      total_pnl_sol: totalPnLSol,
      total_pnl_usd: totalPnLUsd,
      win_rate: totalCount > 0 ? (winCount / totalCount) * 100 : 0,
      avg_return_multiple: avgReturnMultiple,
      graduated_tokens_count: tokenGroups.size,
      avg_hold_time_minutes: holdTimeCount > 0 ? totalHoldTime / holdTimeCount : 0,
      first_buy_timing_avg: 0, // Will calculate separately
      total_trades: transactions.length
    };
  }

  /**
   * Calculate PnL for a single token
   */
  private calculateTokenPnL(transactions: TransactionData[]): PnLCalculation {
    let totalBought = 0;
    let totalSold = 0;
    let totalBoughtValue = 0;
    let totalSoldValue = 0;
    
    for (const tx of transactions) {
      if (tx.type === 'buy') {
        totalBought += tx.amount;
        totalBoughtValue += tx.solValue;
      } else {
        totalSold += tx.amount;
        totalSoldValue += tx.solValue;
      }
    }
    
    const currentBalance = totalBought - totalSold;
    const avgBuyPrice = totalBought > 0 ? totalBoughtValue / totalBought : 0;
    const avgSellPrice = totalSold > 0 ? totalSoldValue / totalSold : 0;
    const realizedPnL = totalSoldValue - (avgBuyPrice * totalSold);
    
    return {
      wallet_address: '',
      token_mint: transactions[0]?.tokenMint || '',
      realized_pnl: realizedPnL,
      unrealized_pnl: 0, // Would need current price
      total_pnl: realizedPnL,
      avg_buy_price: avgBuyPrice,
      avg_sell_price: avgSellPrice > 0 ? avgSellPrice : undefined,
      current_price: undefined,
      total_bought: totalBought,
      total_sold: totalSold,
      current_balance: currentBalance
    };
  }

  /**
   * Calculate hold time for a token
   */
  private calculateHoldTime(transactions: TransactionData[]): number {
    const buys = transactions.filter(tx => tx.type === 'buy').sort((a, b) => 
      new Date(a.blockTime).getTime() - new Date(b.blockTime).getTime()
    );
    
    const sells = transactions.filter(tx => tx.type === 'sell').sort((a, b) => 
      new Date(a.blockTime).getTime() - new Date(b.blockTime).getTime()
    );
    
    if (buys.length === 0 || sells.length === 0) {
      return 0;
    }
    
    const firstBuy = new Date(buys[0].blockTime).getTime();
    const firstSell = new Date(sells[0].blockTime).getTime();
    
    return Math.max(0, (firstSell - firstBuy) / (1000 * 60)); // Minutes
  }

  /**
   * Classify wallet based on behavior
   */
  private classifyWallet(
    transactions: TransactionData[],
    metrics: WalletMetrics
  ): WalletClassification {
    const indicators = {
      transaction_speed: 0,
      pattern_consistency: 0,
      volume_size: 0,
      timing_precision: 0
    };
    
    const reasoning: string[] = [];
    let walletType: WalletTrader['wallet_type'] = 'normal';
    let confidence = 0.5;
    
    // Check transaction speed (bot detection)
    if (transactions.length >= 10) {
      const timeDiffs = this.calculateTransactionTimeDiffs(transactions);
      const avgTimeDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
      
      if (avgTimeDiff < 5000) { // Less than 5 seconds average
        indicators.transaction_speed = 0.9;
        walletType = 'bot';
        confidence = 0.8;
        reasoning.push('Very fast transaction speed (< 5s average)');
      }
    }
    
    // Check volume (whale detection)
    const totalVolume = transactions.reduce((sum, tx) => sum + tx.solValue, 0);
    if (totalVolume > 1000) { // More than 1000 SOL
      indicators.volume_size = 0.9;
      if (walletType === 'normal') {
        walletType = 'whale';
        confidence = 0.7;
        reasoning.push(`High volume trader (${totalVolume.toFixed(2)} SOL)`);
      }
    }
    
    // Check performance (influencer/skilled trader)
    if (metrics.win_rate > 75 && metrics.graduated_tokens_count > 5) {
      if (walletType === 'normal') {
        walletType = 'influencer';
        confidence = 0.6;
        reasoning.push(`High performance (${metrics.win_rate.toFixed(1)}% win rate)`);
      }
    }
    
    // Check for dev wallet patterns (early consistent buys)
    const earlyBuyPattern = this.checkEarlyBuyPattern(transactions);
    if (earlyBuyPattern) {
      indicators.timing_precision = 0.8;
      if (walletType === 'normal' || walletType === 'bot') {
        walletType = 'dev';
        confidence = 0.7;
        reasoning.push('Consistent early token purchases');
      }
    }
    
    return {
      wallet_type: walletType,
      confidence,
      reasoning,
      indicators
    };
  }

  /**
   * Calculate reputation score
   */
  private calculateReputationScore(
    metrics: WalletMetrics,
    classification: WalletClassification
  ): number {
    let score = 50; // Base score
    
    // Positive factors
    if (metrics.win_rate > 60) score += 10;
    if (metrics.win_rate > 75) score += 10;
    if (metrics.avg_return_multiple > 2) score += 10;
    if (metrics.avg_return_multiple > 5) score += 10;
    if (metrics.graduated_tokens_count > 10) score += 10;
    
    // Negative factors
    if (classification.wallet_type === 'bot') score -= 20;
    if (classification.wallet_type === 'sybil') score -= 30;
    
    // Ensure score is within bounds
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Detect suspicious activity
   */
  private detectSuspiciousActivity(transactions: TransactionData[]): number {
    let suspiciousCount = 0;
    
    // Check for wash trading patterns (buy and sell within seconds)
    const timeDiffs = this.calculateTransactionTimeDiffs(transactions);
    const veryFastTrades = timeDiffs.filter(diff => diff < 1000).length; // < 1 second
    
    if (veryFastTrades > 5) {
      suspiciousCount++;
    }
    
    // Check for round number patterns (likely bot)
    const roundNumbers = transactions.filter(tx => 
      tx.amount % 100 === 0 || tx.amount % 1000 === 0
    ).length;
    
    if (roundNumbers / transactions.length > 0.5) {
      suspiciousCount++;
    }
    
    return suspiciousCount;
  }

  /**
   * Helper: Calculate time differences between transactions
   */
  private calculateTransactionTimeDiffs(transactions: TransactionData[]): number[] {
    const sorted = [...transactions].sort((a, b) => 
      new Date(a.blockTime).getTime() - new Date(b.blockTime).getTime()
    );
    
    const diffs: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const diff = new Date(sorted[i].blockTime).getTime() - 
                   new Date(sorted[i-1].blockTime).getTime();
      diffs.push(diff);
    }
    
    return diffs;
  }

  /**
   * Helper: Check for early buy pattern
   */
  private checkEarlyBuyPattern(transactions: TransactionData[]): boolean {
    // Group by token
    const tokenGroups = new Map<string, TransactionData[]>();
    
    for (const tx of transactions) {
      if (!tokenGroups.has(tx.tokenMint)) {
        tokenGroups.set(tx.tokenMint, []);
      }
      tokenGroups.get(tx.tokenMint)!.push(tx);
    }
    
    // Check if wallet consistently buys early
    let earlyBuyCount = 0;
    
    for (const [token, txs] of tokenGroups) {
      const sorted = txs.sort((a, b) => 
        new Date(a.blockTime).getTime() - new Date(b.blockTime).getTime()
      );
      
      if (sorted.length > 0 && sorted[0].type === 'buy') {
        // This is simplified - would need to check against token launch time
        earlyBuyCount++;
      }
    }
    
    return earlyBuyCount >= 3 && earlyBuyCount / tokenGroups.size > 0.5;
  }

  /**
   * Helper: Get first seen date
   */
  private getFirstSeenDate(transactions: TransactionData[]): Date {
    if (transactions.length === 0) return new Date();
    
    const sorted = [...transactions].sort((a, b) => 
      new Date(a.blockTime).getTime() - new Date(b.blockTime).getTime()
    );
    
    return new Date(sorted[0].blockTime);
  }

  /**
   * Helper: Get last activity date
   */
  private getLastActivityDate(transactions: TransactionData[]): Date {
    if (transactions.length === 0) return new Date();
    
    const sorted = [...transactions].sort((a, b) => 
      new Date(b.blockTime).getTime() - new Date(a.blockTime).getTime()
    );
    
    return new Date(sorted[0].blockTime);
  }
}

export const walletProfileExtractor = new WalletProfileExtractor();