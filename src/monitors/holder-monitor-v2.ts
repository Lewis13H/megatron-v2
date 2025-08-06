import { HolderAnalysisService, AnalysisResult } from '../services/holder-analysis/holder-analysis-service';
// import { CreditTracker } from '../services/holder-analysis/credit-tracker';
import { getDbPool } from '../database/connection';
import chalk from 'chalk';

interface Token {
  id: string;
  mint_address: string;
  symbol: string;
  bonding_curve_progress: number;
  last_analyzed?: Date;
  priority_score?: number;
}

interface MonitorConfig {
  intervalMs: number;
  batchSize: number;
  maxConcurrent: number;
  minProgress: number;
  maxProgress: number;
  targetUsagePercent: number;
}

export class HolderMonitorV2 {
  private analysisService: HolderAnalysisService;
  // private creditTracker: CreditTracker;
  private dbPool: any;
  private isRunning = false;
  private config: MonitorConfig;
  private analysisCount = 0;
  private startTime: Date;
  
  constructor(config?: Partial<MonitorConfig>) {
    this.analysisService = new HolderAnalysisService();
    // this.creditTracker = CreditTracker.getInstance(10_000_000);
    this.dbPool = getDbPool();
    this.startTime = new Date();
    
    // Default config optimized for 50-75% credit usage
    this.config = {
      intervalMs: 60000, // 1 minute default
      batchSize: 10,     // Analyze 10 tokens per batch
      maxConcurrent: 5,  // 5 concurrent analyses
      minProgress: 5,    // Min 5% bonding curve
      maxProgress: 70,   // Max 70% bonding curve
      targetUsagePercent: 62.5, // Target 62.5% of monthly credits
      ...config
    };
  }
  
  async start(): Promise<void> {
    this.isRunning = true;
    console.log(chalk.green('🚀 Holder Monitor V2 Started'));
    console.log(chalk.gray('━'.repeat(50)));
    console.log(chalk.cyan('Configuration:'));
    console.log(chalk.gray(`  • Interval: ${this.config.intervalMs / 1000}s`));
    console.log(chalk.gray(`  • Batch Size: ${this.config.batchSize} tokens`));
    console.log(chalk.gray(`  • Progress Range: ${this.config.minProgress}-${this.config.maxProgress}%`));
    console.log(chalk.gray(`  • Target Usage: ${this.config.targetUsagePercent}% of credits`));
    console.log(chalk.gray('━'.repeat(50)));
    
    // Initial stats display
    await this.displayStats();
    
    // Main loop
    while (this.isRunning) {
      try {
        await this.runAnalysisCycle();
        
        // Adjust interval based on credit usage
        const adjustedInterval = await this.getAdjustedInterval();
        await this.sleep(adjustedInterval);
        
      } catch (error) {
        console.error(chalk.red('Error in analysis cycle:'), error);
        await this.sleep(this.config.intervalMs);
      }
    }
  }
  
  async stop(): Promise<void> {
    console.log(chalk.yellow('\n⏹️  Stopping Holder Monitor...'));
    this.isRunning = false;
  }
  
  private async runAnalysisCycle(): Promise<void> {
    // Check if we should run based on credit usage
    const canRun = await this.shouldRunAnalysis();
    if (!canRun) {
      console.log(chalk.yellow('⚠️  Skipping cycle - approaching credit limit'));
      return;
    }
    
    // Get tokens for analysis
    const tokens = await this.getTokensForAnalysis();
    if (tokens.length === 0) {
      console.log(chalk.gray('No tokens ready for analysis'));
      return;
    }
    
    console.log(chalk.cyan(`\n📊 Analyzing ${tokens.length} tokens...`));
    
    // Analyze in batches with concurrency control
    const results = await this.batchAnalyze(tokens, this.config.maxConcurrent);
    
    // Process and display results
    await this.processResults(results);
    
    // Update stats
    this.analysisCount += results.length;
    await this.displayStats();
  }
  
  private async getTokensForAnalysis(): Promise<Token[]> {
    try {
      // Use the database function to get prioritized tokens
      const result = await this.dbPool.query(
        'SELECT * FROM get_tokens_for_holder_analysis($1)',
        [this.config.batchSize]
      );
      
      return result.rows.map((row: any) => ({
        id: row.token_id,
        mint_address: row.mint_address,
        symbol: row.symbol,
        bonding_curve_progress: parseFloat(row.bonding_curve_progress),
        last_analyzed: row.last_analyzed,
        priority_score: row.priority_score
      }));
      
    } catch (error) {
      console.error(chalk.red('Error fetching tokens:'), error);
      return [];
    }
  }
  
  private async batchAnalyze(tokens: Token[], concurrency: number): Promise<AnalysisResult[]> {
    const results: AnalysisResult[] = [];
    
    // Process in chunks with concurrency limit
    for (let i = 0; i < tokens.length; i += concurrency) {
      const batch = tokens.slice(i, i + concurrency);
      
      console.log(chalk.gray(`  Processing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(tokens.length / concurrency)}`));
      
      const batchPromises = batch.map(async (token) => {
        try {
          console.log(chalk.gray(`    • Analyzing ${token.symbol} (${token.bonding_curve_progress.toFixed(1)}% progress)`));
          
          const result = await this.analysisService.analyzeToken(
            token.mint_address,
            token.bonding_curve_progress
          );
          
          if (result) {
            console.log(chalk.green(`    ✅ ${token.symbol}: Score ${result.score.total}/333`));
          } else {
            console.log(chalk.gray(`    ⏭️  ${token.symbol}: Skipped (not eligible)`));
          }
          
          return result;
        } catch (error) {
          console.error(chalk.red(`    ❌ ${token.symbol}: Analysis failed`), error);
          return null;
        }
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      // Collect successful results
      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      }
      
      // Brief pause between batches
      if (i + concurrency < tokens.length) {
        await this.sleep(1000);
      }
    }
    
    return results;
  }
  
  private async processResults(results: AnalysisResult[]): Promise<void> {
    if (results.length === 0) return;
    
    console.log(chalk.cyan('\n📈 Analysis Results:'));
    console.log(chalk.gray('━'.repeat(50)));
    
    // Sort by score
    const sorted = results.sort((a, b) => b.score.total - a.score.total);
    
    // Display top results
    for (const result of sorted.slice(0, 5)) {
      const symbol = result.token.symbol || result.token.mint.slice(0, 8);
      const score = result.score.total;
      const risk = result.metrics.risk.overall;
      
      // Color code based on score
      let scoreColor = chalk.red;
      if (score > 250) scoreColor = chalk.green;
      else if (score > 150) scoreColor = chalk.yellow;
      
      console.log(
        `  ${scoreColor(`${symbol}`)}: ` +
        `Score: ${scoreColor(score)}/333 | ` +
        `Risk: ${this.getRiskColor(risk)(risk.toFixed(0))}/100 | ` +
        `Holders: ${result.metrics.distribution.uniqueHolders} | ` +
        `Gini: ${result.metrics.distribution.giniCoefficient.toFixed(3)}`
      );
      
      // Display alerts
      for (const alert of result.alerts.slice(0, 2)) {
        const alertIcon = 
          alert.type === 'CRITICAL' ? '🚨' :
          alert.type === 'WARNING' ? '⚠️' :
          alert.type === 'POSITIVE' ? '✅' : 'ℹ️';
        console.log(chalk.gray(`    ${alertIcon} ${alert.message}`));
      }
    }
    
    console.log(chalk.gray('━'.repeat(50)));
    
    // Summary statistics
    const avgScore = results.reduce((sum, r) => sum + r.score.total, 0) / results.length;
    const totalCredits = results.reduce((sum, r) => sum + r.apiCreditsUsed, 0);
    const highScores = results.filter(r => r.score.total > 200).length;
    const criticalAlerts = results.filter(r => 
      r.alerts.some(a => a.type === 'CRITICAL')
    ).length;
    
    console.log(chalk.cyan('Summary:'));
    console.log(chalk.gray(`  • Average Score: ${avgScore.toFixed(1)}/333`));
    console.log(chalk.gray(`  • High Scores (>200): ${highScores}`));
    console.log(chalk.gray(`  • Critical Alerts: ${criticalAlerts}`));
    console.log(chalk.gray(`  • Credits Used: ${totalCredits}`));
  }
  
  private async displayStats(): Promise<void> {
    // Credit tracking disabled
    const stats = { daily: 0, weekly: 0, monthly: 0, projectedMonthly: 0, percentageUsed: 0, remainingCredits: 10000000, willExceedLimit: false, recommendedDailyLimit: 100000 };
    const frequency = { tokensPerHour: 100, message: 'Credit tracking disabled' };
    
    const runtime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    const hours = Math.floor(runtime / 3600);
    const minutes = Math.floor((runtime % 3600) / 60);
    
    console.log(chalk.cyan('\n📊 Monitor Statistics:'));
    console.log(chalk.gray('━'.repeat(50)));
    console.log(chalk.gray(`  • Runtime: ${hours}h ${minutes}m`));
    console.log(chalk.gray(`  • Tokens Analyzed: ${this.analysisCount}`));
    console.log(chalk.gray(`  • Credits Today: ${this.formatNumber(stats.daily)}`));
    console.log(chalk.gray(`  • Credits This Month: ${this.formatNumber(stats.monthly)} (${stats.percentageUsed.toFixed(1)}%)`));
    console.log(chalk.gray(`  • Projected Monthly: ${this.formatNumber(stats.projectedMonthly)}`));
    console.log(chalk.gray(`  • Recommended Rate: ${frequency.tokensPerHour} tokens/hour`));
    
    // Status indicator
    const statusEmoji = 
      stats.percentageUsed >= 85 ? '🚨' :
      stats.percentageUsed >= 75 ? '⚠️' :
      stats.percentageUsed >= 50 ? '✅' : '🎯';
    
    console.log(chalk.gray(`  • Status: ${statusEmoji} ${this.getStatusMessage(stats.percentageUsed)}`));
    console.log(chalk.gray('━'.repeat(50)));
  }
  
  private async shouldRunAnalysis(): Promise<boolean> {
    // Credit tracking disabled
    const stats = { daily: 0, weekly: 0, monthly: 0, projectedMonthly: 0, percentageUsed: 0, remainingCredits: 10000000, willExceedLimit: false, recommendedDailyLimit: 100000 };
    
    // Stop at 85% usage
    if (stats.percentageUsed >= 85) {
      return false;
    }
    
    // Check if we're on track for target usage
    if (stats.projectedMonthly > this.config.targetUsagePercent * 100000) {
      // Slow down if projecting too high
      return Math.random() < 0.5; // 50% chance to skip
    }
    
    return true;
  }
  
  private async getAdjustedInterval(): Promise<number> {
    // Credit tracking disabled - use fixed interval
    return this.config.intervalMs;
  }
  
  private getRiskColor(risk: number): any {
    if (risk >= 80) return chalk.red;
    if (risk >= 60) return chalk.yellow;
    if (risk >= 40) return chalk.white;
    return chalk.green;
  }
  
  private formatNumber(num: number): string {
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toFixed(0);
  }
  
  private getStatusMessage(percentage: number): string {
    if (percentage >= 85) return 'Critical - Approaching limit';
    if (percentage >= 75) return 'Warning - Reduce usage';
    if (percentage >= 50) return 'On target - Optimal usage';
    if (percentage >= 25) return 'Below target - Can increase';
    return 'Low usage - Increase analysis rate';
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Standalone runner with graceful shutdown
async function runMonitor() {
  const monitor = new HolderMonitorV2({
    intervalMs: 60000,        // Check every minute
    batchSize: 10,            // 10 tokens per batch
    maxConcurrent: 5,         // 5 concurrent analyses
    targetUsagePercent: 62.5  // Target 62.5% of monthly credits
  });
  
  // Handle shutdown gracefully
  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\nReceived SIGINT, shutting down gracefully...'));
    await monitor.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log(chalk.yellow('\n\nReceived SIGTERM, shutting down gracefully...'));
    await monitor.stop();
    process.exit(0);
  });
  
  // Start the monitor
  try {
    await monitor.start();
  } catch (error) {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  }
}

// Export for use in other modules
export { runMonitor };

// Run if executed directly
if (require.main === module) {
  runMonitor().catch(error => {
    console.error(chalk.red('Failed to start monitor:'), error);
    process.exit(1);
  });
}