import { Helius } from "helius-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { saveHolderScore, getLatestHolderScore } from "../database/monitor-integration";
import { getDbPool } from "../database/connection";

interface HolderScore {
  total: number;
  distribution: number;
  quality: number;
  activity: number;
  timestamp: number;
  bondingCurveProgress: number;
  details: {
    giniCoefficient: number;
    top10Concentration: number;
    uniqueHolders: number;
    avgWalletAge: number;
    botRatio: number;
    organicGrowthScore: number;
  };
}

interface HolderDetail {
  address: string;
  balance: number;
  transactionCount: number;
  tokenCount: number;
  accountAge: number;
  tokenBalance?: number;
  isBot?: boolean;
  walletScore?: number;
}

interface TokenTransaction {
  signature: string;
  timestamp: number;
  type: 'buy' | 'sell';
  amount: number;
  price: number;
  wallet: string;
  program: string;
}

export class HolderScoreAnalyzer {
  private helius: Helius;
  private connection: Connection;
  
  constructor(heliusApiKey: string, rpcUrl: string) {
    this.helius = new Helius(heliusApiKey);
    this.connection = new Connection(rpcUrl);
  }
  
  async analyzeToken(
    mint: string, 
    bondingCurveProgress: number,
    transactions?: TokenTransaction[],
    tokenCreationTime?: Date
  ): Promise<HolderScore | null> {
    // Check primary activation criteria
    if (bondingCurveProgress < 10) {
      console.log(`Token below activation threshold: ${bondingCurveProgress.toFixed(2)}% (requires minimum 10%)`);
      return null;
    }
    
    // Check if we need to freeze the score (at or near 100% progress)
    if (bondingCurveProgress >= 95) {
      // Check if we have an existing score to freeze
      const existingScore = await getLatestHolderScore(mint);
      if (existingScore && !existingScore.is_frozen && bondingCurveProgress >= 100) {
        console.log(`Token has graduated (${bondingCurveProgress}% progress), freezing existing score`);
        await this.freezeHolderScore(mint);
      }
      
      // Return the frozen score if available
      if (existingScore?.is_frozen) {
        console.log(`Returning frozen score for graduated token`);
        return {
          total: existingScore.total_score,
          distribution: existingScore.distribution_score,
          quality: existingScore.quality_score,
          activity: existingScore.activity_score,
          timestamp: new Date(existingScore.score_time).getTime(),
          bondingCurveProgress: existingScore.bonding_curve_progress,
          details: {
            giniCoefficient: existingScore.gini_coefficient,
            top10Concentration: existingScore.top_10_concentration,
            uniqueHolders: existingScore.unique_holders,
            avgWalletAge: existingScore.avg_wallet_age_days,
            botRatio: existingScore.bot_ratio,
            organicGrowthScore: existingScore.organic_growth_score
          }
        };
      }
      
      if (bondingCurveProgress >= 100) {
        console.log(`Token graduated but no score to freeze`);
        return null;
      }
    }
    
    try {
      // Check secondary activation criteria
      
      // 1. Check token age (30 minutes minimum)
      if (tokenCreationTime) {
        const tokenAgeMinutes = (Date.now() - tokenCreationTime.getTime()) / (1000 * 60);
        if (tokenAgeMinutes < 30) {
          console.log(`Token too young: ${tokenAgeMinutes.toFixed(1)} minutes (minimum 30 minutes required)`);
          return null;
        }
      }
      
      // 2. Check transaction count (minimum 3)
      if (transactions && transactions.length < 3) {
        console.log(`Insufficient transactions: ${transactions.length} (minimum 3 required)`);
        return null;
      }
      
      // Fetch all token holders
      console.log(`Fetching holders for token ${mint}...`);
      const holders = await this.fetchAllHolders(mint);
      
      // 3. Check holder count (minimum 5)
      if (holders.length < 5) {
        console.log(`Insufficient holders (${holders.length}), minimum 5 required`);
        return null;
      }
      
      // Enrich holder data with detailed information
      console.log(`Enriching data for ${holders.length} holders...`);
      const holderDetails = await this.enrichHolderData(holders, mint);
      
      // Calculate distribution score (111 points)
      const distributionScore = await this.calculateDistributionScore(holderDetails);
      
      // Calculate quality score (111 points)
      const qualityScore = await this.calculateQualityScore(holderDetails);
      
      // Calculate activity score (111 points)
      const activityScore = await this.calculateActivityScore(
        mint, 
        holderDetails, 
        transactions
      );
      
      // Compile final score
      const totalScore = distributionScore.score + qualityScore.score + activityScore.score;
      
      const score: HolderScore = {
        total: totalScore,
        distribution: distributionScore.score,
        quality: qualityScore.score,
        activity: activityScore.score,
        timestamp: Date.now(),
        bondingCurveProgress,
        details: {
          giniCoefficient: distributionScore.gini,
          top10Concentration: distributionScore.top10Concentration,
          uniqueHolders: holders.length,
          avgWalletAge: qualityScore.avgWalletAge,
          botRatio: qualityScore.botRatio,
          organicGrowthScore: activityScore.organicScore
        }
      };
      
      // Save to database
      await saveHolderScore(mint, score);
      
      return score;
      
    } catch (error) {
      console.error(`Error analyzing holder score for ${mint}:`, error);
      return null;
    }
  }
  
  private async fetchAllHolders(mint: string): Promise<string[]> {
    const holders = new Set<string>();
    let page = 1;
    const limit = 1000;
    
    while (true) {
      try {
        // Use Helius RPC to get token accounts
        const response = await this.helius.rpc.getTokenAccounts({
          mint,
          page,
          limit
        });
        
        if (!response?.token_accounts || response.token_accounts.length === 0) {
          break;
        }
        
        // Add unique holders with positive balance
        response.token_accounts.forEach((account: any) => {
          if (account.amount && parseInt(account.amount) > 0) {
            holders.add(account.owner);
          }
        });
        
        // Check if we've fetched all accounts
        if (response.token_accounts.length < limit) {
          break;
        }
        
        page++;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`Error fetching holders page ${page}:`, error);
        break;
      }
    }
    
    return Array.from(holders);
  }
  
  private async enrichHolderData(
    holders: string[], 
    mint: string
  ): Promise<HolderDetail[]> {
    const batchSize = 100;
    const allDetails: HolderDetail[] = [];
    
    for (let i = 0; i < holders.length; i += batchSize) {
      const batch = holders.slice(i, i + batchSize);
      
      const batchDetails = await Promise.all(
        batch.map(async (holder, index) => {
          try {
            // Add delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, index * 100));
            
            // Get account info
            const accountInfo = await this.connection.getAccountInfo(new PublicKey(holder));
            
            // For now, skip transaction history to reduce API calls
            const accountAge = 30; // Default age assumption
            
            // Get token balance
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
              new PublicKey(holder),
              { mint: new PublicKey(mint) }
            );
            
            const tokenBalance = tokenAccounts.value.length > 0
              ? tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount
              : 0;
            
            return {
              address: holder,
              balance: accountInfo ? accountInfo.lamports / 1e9 : 0,
              transactionCount: 50, // Default assumption
              tokenCount: 0,
              accountAge,
              tokenBalance
            };
          } catch (error) {
            console.error(`Error enriching holder ${holder}:`, error);
            return {
              address: holder,
              balance: 0,
              transactionCount: 0,
              tokenCount: 0,
              accountAge: 0,
              tokenBalance: 0
            };
          }
        })
      );
      
      allDetails.push(...batchDetails);
      
      // Rate limiting between batches
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return allDetails;
  }
  
  private async calculateDistributionScore(
    holderDetails: HolderDetail[]
  ): Promise<{ score: number; gini: number; top10Concentration: number }> {
    // Sort by token balance
    const sortedHolders = holderDetails
      .filter(h => h.tokenBalance && h.tokenBalance > 0)
      .sort((a, b) => (b.tokenBalance || 0) - (a.tokenBalance || 0));
    
    const totalSupply = sortedHolders.reduce((sum, h) => sum + (h.tokenBalance || 0), 0);
    
    // Calculate Gini coefficient
    const gini = this.calculateGiniCoefficient(sortedHolders.map(h => h.tokenBalance || 0));
    
    // Calculate concentration metrics
    const top10Supply = sortedHolders.slice(0, 10).reduce((sum, h) => sum + (h.tokenBalance || 0), 0);
    const top10Concentration = (top10Supply / totalSupply) * 100;
    
    const topHolder = sortedHolders[0];
    const topHolderPercentage = ((topHolder?.tokenBalance || 0) / totalSupply) * 100;
    
    // Score components (111 points total)
    let concentrationScore = 40;
    if (topHolderPercentage > 15) concentrationScore = 0;
    else if (topHolderPercentage > 10) concentrationScore = 10;
    else if (topHolderPercentage > 7) concentrationScore = 25;
    
    const giniScore = (1 - gini) * 40;
    
    const velocityScore = Math.min(31, sortedHolders.length / 10);
    
    return {
      score: concentrationScore + giniScore + velocityScore,
      gini,
      top10Concentration
    };
  }
  
  private calculateGiniCoefficient(values: number[]): number {
    const sorted = values.sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    
    if (sum === 0) return 0;
    
    let giniSum = 0;
    for (let i = 0; i < n; i++) {
      giniSum += (2 * (i + 1) - n - 1) * sorted[i];
    }
    
    return giniSum / (n * sum);
  }
  
  private async calculateQualityScore(
    holderDetails: HolderDetail[]
  ): Promise<{ score: number; avgWalletAge: number; botRatio: number }> {
    // Wallet age analysis (40 points)
    const avgWalletAge = holderDetails.reduce((sum, h) => sum + h.accountAge, 0) / holderDetails.length;
    let ageScore = 0;
    if (avgWalletAge > 90) ageScore = 40;
    else if (avgWalletAge > 30) ageScore = 30;
    else if (avgWalletAge > 7) ageScore = 20;
    else ageScore = 10;
    
    // Bot detection (31 points)
    const botCount = holderDetails.filter(h => this.detectBot(h)).length;
    const botRatio = botCount / holderDetails.length;
    const botScore = Math.max(0, 31 - (botRatio * 100));
    
    // Diamond hand analysis (40 points)
    const qualityHolders = holderDetails.filter(h => 
      h.accountAge > 30 && 
      h.transactionCount > 50 && 
      h.balance > 0.1
    ).length;
    const qualityRatio = qualityHolders / holderDetails.length;
    const diamondScore = qualityRatio * 40;
    
    return {
      score: ageScore + botScore + diamondScore,
      avgWalletAge,
      botRatio
    };
  }
  
  private detectBot(holder: HolderDetail): boolean {
    const signals = {
      lowBalance: holder.balance < 0.05,
      newAccount: holder.accountAge < 1,
      lowActivity: holder.transactionCount < 5,
      suspiciousBalance: holder.balance === 0.01 || holder.balance === 0.05
    };
    
    const botSignals = Object.values(signals).filter(s => s).length;
    return botSignals >= 3;
  }
  
  private async calculateActivityScore(
    mint: string,
    holderDetails: HolderDetail[],
    transactions?: TokenTransaction[]
  ): Promise<{ score: number; organicScore: number }> {
    // Organic growth detection (40 points)
    let organicScore = 20; // Base score
    
    if (transactions && transactions.length > 0) {
      // Analyze transaction patterns
      const buySizes = transactions
        .filter(tx => tx.type === 'buy')
        .map(tx => tx.amount);
      
      // Check for size diversity
      const uniqueSizes = new Set(buySizes.map(s => s.toFixed(2))).size;
      const sizeRatio = uniqueSizes / buySizes.length;
      if (sizeRatio > 0.7) organicScore += 10;
      
      // Check timing patterns
      const timeDiffs = [];
      for (let i = 1; i < transactions.length; i++) {
        timeDiffs.push(transactions[i].timestamp - transactions[i-1].timestamp);
      }
      const avgTimeDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
      const timeVariance = this.calculateVariance(timeDiffs);
      
      if (timeVariance > avgTimeDiff * 0.5) organicScore += 10;
    }
    
    // Transaction diversity (40 points)
    const uniqueBalances = new Set(
      holderDetails.map(h => Math.floor(h.balance * 100))
    ).size;
    const diversityRatio = uniqueBalances / holderDetails.length;
    const diversityScore = Math.min(40, diversityRatio * 50);
    
    // Network effects (31 points)
    const activeHolders = holderDetails.filter(h => h.transactionCount > 10).length;
    const activeRatio = activeHolders / holderDetails.length;
    const networkScore = activeRatio * 31;
    
    return {
      score: organicScore + diversityScore + networkScore,
      organicScore: organicScore / 40
    };
  }
  
  private calculateVariance(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }
  
  /**
   * Freeze the holder score when token graduates (reaches 100% bonding curve)
   */
  private async freezeHolderScore(tokenMint: string): Promise<void> {
    try {
      const pool = getDbPool();
      
      // Update the latest score to be frozen
      const query = `
        UPDATE holder_scores
        SET is_frozen = TRUE
        WHERE token_id = (SELECT id FROM tokens WHERE mint_address = $1)
          AND score_time = (
            SELECT MAX(score_time) 
            FROM holder_scores hs2 
            WHERE hs2.token_id = holder_scores.token_id
          )
          AND is_frozen = FALSE
      `;
      
      await pool.query(query, [tokenMint]);
      console.log(`Frozen holder score for graduated token: ${tokenMint}`);
    } catch (error) {
      console.error(`Error freezing holder score for ${tokenMint}:`, error);
    }
  }
}

// Alert system for real-time monitoring
export class HolderScoreMonitor {
  private analyzer: HolderScoreAnalyzer;
  
  constructor(heliusApiKey: string, rpcUrl: string) {
    this.analyzer = new HolderScoreAnalyzer(heliusApiKey, rpcUrl);
  }
  
  async monitorToken(
    mint: string, 
    bondingCurveProgress: number,
    callback: (score: HolderScore | null, alerts: string[]) => void
  ): Promise<void> {
    const score = await this.analyzer.analyzeToken(mint, bondingCurveProgress);
    const alerts: string[] = [];
    
    if (score) {
      // Check for red flags
      if (score.details.top10Concentration > 50) {
        alerts.push(`🚨 HIGH CONCENTRATION: Top 10 holders own ${score.details.top10Concentration.toFixed(1)}%`);
      }
      
      if (score.details.botRatio > 0.3) {
        alerts.push(`🤖 BOT ALERT: ${(score.details.botRatio * 100).toFixed(1)}% suspected bot wallets`);
      }
      
      if (score.details.giniCoefficient > 0.8) {
        alerts.push(`📊 POOR DISTRIBUTION: Gini coefficient ${score.details.giniCoefficient.toFixed(3)}`);
      }
      
      // Check for positive signals
      if (score.total > 250) {
        alerts.push(`✅ STRONG HOLDER BASE: Score ${score.total}/333`);
      }
      
      if (score.details.avgWalletAge > 60 && score.details.botRatio < 0.1) {
        alerts.push(`💎 QUALITY HOLDERS: Avg age ${score.details.avgWalletAge.toFixed(0)} days`);
      }
    }
    
    callback(score, alerts);
  }
}

// Integration with existing Megatron V2 monitors
export async function integrateHolderScoring(
  heliusApiKey: string,
  rpcUrl: string
): Promise<HolderScoreMonitor> {
  const monitor = new HolderScoreMonitor(heliusApiKey, rpcUrl);
  
  console.log("✅ Holder Score system initialized");
  console.log("📊 Monitoring tokens between 10-25% bonding curve progress");
  
  return monitor;
}