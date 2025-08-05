import { getDbPool } from '../database/connection';
import { getHeliusService, HeliusAPIService } from './helius-api-service';
import { HolderScoreAnalyzer } from '../scoring/holder-score-implementation';

interface TokenToAnalyze {
  id: string;
  mintAddress: string;
  symbol: string;
  name: string;
  bondingCurveProgress: number;
  createdAt?: Date;
  transactionCount?: number;
}

export class HolderSnapshotService {
  private heliusService: HeliusAPIService;
  private holderScoreAnalyzer: HolderScoreAnalyzer;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(heliusApiKey: string, rpcUrl: string) {
    this.heliusService = getHeliusService(heliusApiKey);
    this.holderScoreAnalyzer = new HolderScoreAnalyzer(heliusApiKey, rpcUrl);
  }

  /**
   * Start the holder snapshot service
   */
  async start(intervalMinutes: number = 5): Promise<void> {
    if (this.isRunning) {
      console.log('Holder snapshot service is already running');
      return;
    }

    console.log(`Starting holder snapshot service (interval: ${intervalMinutes} minutes)`);
    this.isRunning = true;

    // Run immediately
    await this.collectSnapshots();

    // Then run on interval
    this.intervalId = setInterval(async () => {
      if (this.isRunning) {
        await this.collectSnapshots();
      }
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Stop the holder snapshot service
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('Holder snapshot service stopped');
  }

  /**
   * Collect snapshots for all eligible tokens
   */
  private async collectSnapshots(): Promise<void> {
    try {
      console.log('Starting holder snapshot collection...');
      
      // Get tokens that need holder analysis (10-25% bonding curve)
      const tokens = await this.getEligibleTokens();
      
      if (tokens.length === 0) {
        console.log('No tokens eligible for holder analysis');
        return;
      }

      console.log(`Found ${tokens.length} tokens eligible for holder analysis`);

      // Process tokens in batches to avoid overwhelming the API
      const batchSize = 5;
      for (let i = 0; i < tokens.length; i += batchSize) {
        const batch = tokens.slice(i, i + batchSize);
        
        await Promise.all(
          batch.map(async (token) => {
            try {
              await this.processToken(token);
            } catch (error) {
              console.error(`Error processing token ${token.symbol}:`, error);
            }
          })
        );

        // Rate limiting between batches
        if (i + batchSize < tokens.length) {
          await this.sleep(2000);
        }
      }

      console.log('Holder snapshot collection completed');
      
    } catch (error) {
      console.error('Error in holder snapshot collection:', error);
    }
  }

  /**
   * Get tokens eligible for holder analysis (10-25% bonding curve)
   */
  private async getEligibleTokens(): Promise<TokenToAnalyze[]> {
    const db = getDbPool();
    
    const query = `
      SELECT 
        t.id,
        t.mint_address,
        t.symbol,
        t.name,
        t.created_at,
        p.bonding_curve_progress,
        (SELECT COUNT(*) FROM transactions WHERE token_id = t.id) as transaction_count
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE p.platform = 'pumpfun'
        AND p.bonding_curve_progress >= 10
        AND p.bonding_curve_progress < 100  -- Analyze until graduation
        AND p.status = 'active'
        -- Secondary activation criteria
        AND t.created_at < NOW() - INTERVAL '30 minutes'  -- Token age requirement
        AND (SELECT COUNT(*) FROM transactions WHERE token_id = t.id) >= 3  -- Min transactions
        AND NOT EXISTS (
          -- Skip if we already have a recent snapshot (within last hour)
          SELECT 1 
          FROM holder_snapshots hs 
          WHERE hs.token_id = t.id 
            AND hs.snapshot_time > NOW() - INTERVAL '1 hour'
        )
      ORDER BY p.bonding_curve_progress DESC
      LIMIT 20
    `;
    
    const result = await db.query(query);
    return result.rows.map((row: any) => ({
      id: row.id,
      mintAddress: row.mint_address,
      symbol: row.symbol,
      name: row.name,
      bondingCurveProgress: parseFloat(row.bonding_curve_progress),
      createdAt: new Date(row.created_at),
      transactionCount: parseInt(row.transaction_count)
    }));
  }

  /**
   * Process a single token
   */
  private async processToken(token: TokenToAnalyze): Promise<void> {
    console.log(`Processing holder data for ${token.symbol} (${token.bondingCurveProgress.toFixed(2)}% progress)`);
    if (token.createdAt) {
      const ageMinutes = (Date.now() - token.createdAt.getTime()) / (1000 * 60);
      console.log(`  Token age: ${ageMinutes.toFixed(1)} minutes`);
    }
    if (token.transactionCount !== undefined) {
      console.log(`  Transaction count: ${token.transactionCount}`);
    }
    
    try {
      // 1. Fetch all token holders
      const holders = await this.heliusService.getAllTokenHolders(token.mintAddress);
      
      if (holders.length < 5) {
        console.log(`Skipping ${token.symbol} - insufficient holders (${holders.length})`);
        return;
      }

      // 2. Analyze wallet quality (optional - skip if too many holders to avoid timeouts)
      let walletAnalyses = new Map<string, any>();
      if (holders.length <= 50) {
        const walletAddresses = holders.map(h => h.owner);
        walletAnalyses = await this.heliusService.analyzeWallets(walletAddresses);
      } else {
        console.log(`Skipping detailed wallet analysis for ${token.symbol} - too many holders (${holders.length})`);
      }

      // 3. Save holder snapshot
      await this.heliusService.saveHolderSnapshot(
        token.id,
        holders,
        token.bondingCurveProgress
      );

      // 4. Save individual holders
      await this.heliusService.saveTokenHolders(
        token.id,
        holders,
        walletAnalyses
      );

      // 5. Calculate and save holder score
      const score = await this.holderScoreAnalyzer.analyzeToken(
        token.mintAddress,
        token.bondingCurveProgress,
        undefined, // transactions - could be fetched if needed
        token.createdAt
      );

      if (score) {
        console.log(`Holder score for ${token.symbol}: ${score.total}/333`);
        
        // Check for alerts
        const alerts = this.generateAlerts(token, score);
        if (alerts.length > 0) {
          console.log(`Alerts for ${token.symbol}:`);
          alerts.forEach(alert => console.log(`  - ${alert}`));
        }
      }

      console.log(`✅ Completed holder analysis for ${token.symbol}`);
      
    } catch (error) {
      console.error(`Failed to process token ${token.symbol}:`, error);
      throw error;
    }
  }

  /**
   * Generate alerts based on holder score
   */
  private generateAlerts(token: TokenToAnalyze, score: any): string[] {
    const alerts: string[] = [];

    // Red flags
    if (score.details.top10Concentration > 50) {
      alerts.push(`🚨 HIGH CONCENTRATION: Top 10 holders own ${score.details.top10Concentration.toFixed(1)}%`);
    }

    if (score.details.botRatio > 0.3) {
      alerts.push(`🤖 BOT ALERT: ${(score.details.botRatio * 100).toFixed(1)}% suspected bot wallets`);
    }

    if (score.details.giniCoefficient > 0.8) {
      alerts.push(`📊 POOR DISTRIBUTION: Gini coefficient ${score.details.giniCoefficient.toFixed(3)}`);
    }

    // Positive signals
    if (score.total > 250) {
      alerts.push(`✅ STRONG HOLDER BASE: Score ${score.total}/333`);
    }

    if (score.details.avgWalletAge > 60 && score.details.botRatio < 0.1) {
      alerts.push(`💎 QUALITY HOLDERS: Avg age ${score.details.avgWalletAge.toFixed(0)} days`);
    }

    if (score.details.organicGrowthScore > 0.8) {
      alerts.push(`🌱 ORGANIC GROWTH: Score ${(score.details.organicGrowthScore * 100).toFixed(0)}%`);
    }

    return alerts;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get latest holder scores for dashboard
   */
  async getLatestHolderScores(limit: number = 20): Promise<any[]> {
    const db = getDbPool();
    
    const query = `
      SELECT 
        t.mint_address,
        t.symbol,
        t.name,
        hs.score_time,
        hs.bonding_curve_progress,
        hs.total_score,
        hs.distribution_score,
        hs.quality_score,
        hs.activity_score,
        hs.unique_holders,
        hs.gini_coefficient,
        hs.top_10_concentration,
        hs.avg_wallet_age_days,
        hs.bot_ratio,
        hs.organic_growth_score,
        hs.red_flags,
        hs.yellow_flags,
        hs.positive_signals
      FROM holder_scores hs
      JOIN tokens t ON hs.token_id = t.id
      WHERE hs.score_time > NOW() - INTERVAL '24 hours'
      ORDER BY hs.total_score DESC, hs.score_time DESC
      LIMIT $1
    `;
    
    const result = await db.query(query, [limit]);
    return result.rows;
  }

  /**
   * Get holder distribution for a specific token
   */
  async getTokenHolderDistribution(mintAddress: string): Promise<any> {
    const db = getDbPool();
    
    const query = `
      SELECT 
        hs.*,
        t.symbol,
        t.name
      FROM holder_snapshots hs
      JOIN tokens t ON hs.token_id = t.id
      WHERE t.mint_address = $1
      ORDER BY hs.snapshot_time DESC
      LIMIT 1
    `;
    
    const result = await db.query(query, [mintAddress]);
    return result.rows[0];
  }
}

// Export function to create and start the service
export async function startHolderSnapshotService(
  heliusApiKey: string,
  rpcUrl: string,
  intervalMinutes?: number
): Promise<HolderSnapshotService> {
  const service = new HolderSnapshotService(heliusApiKey, rpcUrl);
  await service.start(intervalMinutes);
  return service;
}