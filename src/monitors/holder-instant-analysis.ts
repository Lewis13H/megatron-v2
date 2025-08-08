import { OptimizedHolderAnalysisService } from '../services/holder-analysis/holder-analysis-service-optimized';
import { getDbPool } from '../database/connection';
import chalk from 'chalk';

interface InstantAnalysisToken {
  token_id: string;
  mint_address: string;
  symbol: string;
  technical_score: number;
  holder_score: number | null;
  bonding_curve_progress: number;
  reason: string;
  triggered_at: Date;
}

/**
 * Instant Holder Analysis Monitor
 * 
 * Specifically handles tokens with high technical scores (180+) that lack holder scores.
 * Runs continuously to ensure high-value tokens get immediate holder analysis.
 */
export class InstantHolderAnalysisMonitor {
  private analysisService: OptimizedHolderAnalysisService;
  private dbPool: any;
  private isRunning = false;
  private stats = {
    analyzed: 0,
    successful: 0,
    failed: 0,
    startTime: new Date()
  };

  constructor() {
    this.analysisService = new OptimizedHolderAnalysisService();
    this.dbPool = getDbPool();
  }

  async start(): Promise<void> {
    this.isRunning = true;
    console.log(chalk.red.bold('⚡ INSTANT Holder Analysis Monitor Started'));
    console.log(chalk.yellow('Monitoring for technical scores ≥180 without holder scores'));
    console.log(chalk.gray('━'.repeat(60)));
    
    // Initial check for existing high-score tokens
    await this.checkExistingHighScores();
    
    // Main monitoring loop
    while (this.isRunning) {
      try {
        await this.processInstantQueue();
        await this.sleep(5000); // Check every 5 seconds
      } catch (error) {
        console.error(chalk.red('Error in instant analysis loop:'), error);
        await this.sleep(10000);
      }
    }
  }

  async stop(): Promise<void> {
    console.log(chalk.yellow('\n⏹️  Stopping Instant Analysis Monitor...'));
    this.isRunning = false;
  }

  private async checkExistingHighScores(): Promise<void> {
    try {
      // Get stats on tokens needing analysis
      const statsResult = await this.dbPool.query('SELECT * FROM get_instant_analysis_stats()');
      const stats = statsResult.rows[0];
      
      if (stats.missing_holder_scores > 0 || stats.stale_holder_scores > 0) {
        console.log(chalk.yellow('\n📊 Initial Status:'));
        console.log(chalk.white(`  • High technical tokens (≥180): ${stats.total_high_technical}`));
        console.log(chalk.red(`  • Missing holder scores: ${stats.missing_holder_scores}`));
        console.log(chalk.yellow(`  • Stale holder scores (>30min): ${stats.stale_holder_scores}`));
        console.log(chalk.cyan(`  • Max technical score: ${stats.max_technical_score}`));
        console.log(chalk.gray('━'.repeat(60)));
      }
      
      // Check for any tokens in the gap
      const gapResult = await this.dbPool.query(`
        SELECT * FROM technical_holder_gap 
        ORDER BY technical_score DESC 
        LIMIT 10
      `);
      
      if (gapResult.rows.length > 0) {
        console.log(chalk.red.bold('\n🚨 HIGH PRIORITY TOKENS WITHOUT HOLDER SCORES:'));
        for (const token of gapResult.rows) {
          console.log(chalk.red(
            `  ${token.symbol}: Tech=${token.technical_score} | ` +
            `Holder=${token.holder_score || 'NONE'} | ` +
            `Status=${token.holder_status}`
          ));
        }
        console.log(chalk.gray('━'.repeat(60)));
      }
      
    } catch (error) {
      console.error(chalk.red('Error checking existing high scores:'), error);
    }
  }

  private async processInstantQueue(): Promise<void> {
    try {
      // Get tokens requiring instant analysis
      const result = await this.dbPool.query('SELECT * FROM get_instant_analysis_tokens()');
      
      if (result.rows.length === 0) {
        // Periodically check for new high technical scores
        if (this.stats.analyzed % 20 === 0) { // Every 100 seconds
          await this.checkForNewHighScores();
        }
        return;
      }
      
      console.log(chalk.red.bold(`\n⚡ INSTANT ANALYSIS BATCH (${result.rows.length} tokens)`));
      
      // Process all instant tokens in parallel (max 5 concurrent)
      const tokens: InstantAnalysisToken[] = result.rows;
      const batchSize = Math.min(5, tokens.length);
      
      for (let i = 0; i < tokens.length; i += batchSize) {
        const batch = tokens.slice(i, i + batchSize);
        
        const promises = batch.map(async (token) => {
          console.log(chalk.yellow(
            `  🎯 ${token.symbol}: Tech=${token.technical_score} | ${token.reason}`
          ));
          
          try {
            // Analyze with highest priority
            const analysisResult = await this.analysisService.analyzeToken(
              token.mint_address,
              token.bonding_curve_progress,
              'high'
            );
            
            if (analysisResult) {
              // Clear instant flag and update scores
              await this.dbPool.query(
                'SELECT clear_instant_analysis_flag($1, $2)',
                [token.token_id, analysisResult.score.total]
              );
              
              // Update token scores
              await this.dbPool.query(
                'SELECT update_token_scores_with_instant_check($1, $2, $3)',
                [token.token_id, 'holder', analysisResult.score.total]
              );
              
              this.stats.successful++;
              
              // Display result
              const scoreColor = 
                analysisResult.score.total >= 250 ? chalk.green :
                analysisResult.score.total >= 150 ? chalk.yellow :
                chalk.red;
              
              console.log(chalk.green(
                `    ✅ ${token.symbol}: Holder Score = ${scoreColor(analysisResult.score.total)}/333 | ` +
                `Combined = ${token.technical_score + analysisResult.score.total}/666`
              ));
              
              // Show critical alerts
              for (const alert of analysisResult.alerts) {
                if (alert.type === 'CRITICAL' || alert.type === 'POSITIVE') {
                  const emoji = alert.type === 'CRITICAL' ? '🚨' : '✅';
                  console.log(chalk.gray(`      ${emoji} ${alert.message}`));
                }
              }
              
              // Check if this is now ultra-critical (combined 500+)
              const combined = token.technical_score + analysisResult.score.total;
              if (combined >= 500) {
                console.log(chalk.red.bold(
                  `    🔥 ULTRA-CRITICAL: ${token.symbol} reached ${combined}/666 combined score!`
                ));
              }
            } else {
              this.stats.failed++;
              console.log(chalk.gray(`    ⏭️  ${token.symbol}: Analysis skipped`));
            }
            
          } catch (error) {
            this.stats.failed++;
            console.error(chalk.red(`    ❌ ${token.symbol}: Analysis failed`), error);
          }
          
          this.stats.analyzed++;
        });
        
        await Promise.allSettled(promises);
        
        // Brief pause between batches
        if (i + batchSize < tokens.length) {
          await this.sleep(2000);
        }
      }
      
      // Display stats
      this.displayStats();
      
    } catch (error) {
      console.error(chalk.red('Error processing instant queue:'), error);
    }
  }

  private async checkForNewHighScores(): Promise<void> {
    try {
      // Query for any tokens with high technical scores missing holder scores
      const result = await this.dbPool.query(`
        UPDATE tokens t
        SET 
          instant_analysis_required = TRUE,
          instant_analysis_reason = 'Periodic check: Tech ' || last_technical_score::TEXT,
          instant_analysis_triggered_at = NOW(),
          next_holder_analysis = NOW()
        FROM pools p
        WHERE 
          p.token_id = t.id
          AND t.last_technical_score >= 180
          AND (
            t.last_holder_score IS NULL OR 
            t.last_holder_score = 0 OR
            t.last_holder_analysis < NOW() - INTERVAL '30 minutes'
          )
          AND p.status = 'active'
          AND t.instant_analysis_required = FALSE
        RETURNING t.symbol, t.last_technical_score
      `);
      
      if (result.rows.length > 0) {
        console.log(chalk.yellow(`\n🔍 Found ${result.rows.length} new high-score tokens needing analysis`));
        for (const token of result.rows) {
          console.log(chalk.yellow(`  • ${token.symbol}: Technical ${token.last_technical_score}`));
        }
      }
      
    } catch (error) {
      console.error(chalk.red('Error checking for new high scores:'), error);
    }
  }

  private displayStats(): void {
    const runtime = Math.floor((Date.now() - this.stats.startTime.getTime()) / 1000);
    const minutes = Math.floor(runtime / 60);
    const seconds = runtime % 60;
    
    console.log(chalk.cyan('\n📊 Instant Analysis Stats:'));
    console.log(chalk.gray(`  • Runtime: ${minutes}m ${seconds}s`));
    console.log(chalk.green(`  • Successful: ${this.stats.successful}`));
    console.log(chalk.red(`  • Failed: ${this.stats.failed}`));
    console.log(chalk.white(`  • Total Analyzed: ${this.stats.analyzed}`));
    console.log(chalk.gray('━'.repeat(60)));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Integration with technical score monitor
export async function onTechnicalScoreUpdate(
  tokenId: string,
  technicalScore: number
): Promise<void> {
  if (technicalScore >= 180) {
    const dbPool = getDbPool();
    
    try {
      // Check if instant analysis is needed
      const result = await dbPool.query(
        'SELECT * FROM update_token_scores_with_instant_check($1, $2, $3)',
        [tokenId, 'technical', technicalScore]
      );
      
      if (result.rows[0]?.needs_instant_analysis) {
        console.log(chalk.red.bold(
          `⚡ INSTANT ANALYSIS TRIGGERED: Technical score ${technicalScore} | ${result.rows[0].reason}`
        ));
      }
    } catch (error) {
      console.error('Error checking instant analysis need:', error);
    }
  }
}

// Standalone runner
async function runInstantAnalysisMonitor() {
  const monitor = new InstantHolderAnalysisMonitor();
  
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
export { runInstantAnalysisMonitor };

// Run if executed directly
if (require.main === module) {
  runInstantAnalysisMonitor().catch(error => {
    console.error(chalk.red('Failed to start instant analysis monitor:'), error);
    process.exit(1);
  });
}