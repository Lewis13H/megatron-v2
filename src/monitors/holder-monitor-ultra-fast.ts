import { OptimizedHolderAnalysisService } from '../services/holder-analysis/holder-analysis-service-optimized';
import { getDbPool } from '../database/connection';
import chalk from 'chalk';

interface Token {
  id: string;
  mint_address: string;
  symbol: string;
  bonding_curve_progress: number;
  technical_score: number;
  holder_score: number;
  combined_score: number;
  last_analyzed?: Date;
  priority_score: number;
  analysis_tier: string;
  recommended_frequency: number;
  reason: string;
}

interface MonitorConfig {
  baseIntervalMs: number;
  maxConcurrent: number;
  ultraCriticalConcurrent: number;
  criticalBatchSize: number;
  standardBatchSize: number;
}

export class UltraFastHolderMonitor {
  private analysisService: OptimizedHolderAnalysisService;
  private dbPool: any;
  private isRunning = false;
  private config: MonitorConfig;
  private analysisStats = {
    instant: 0,
    ultraCritical: 0,
    critical: 0,
    highPriority: 0,
    standard: 0,
    total: 0,
    startTime: new Date()
  };
  
  // Separate queues for different priority tiers
  private ultraCriticalQueue: Token[] = [];
  private criticalQueue: Token[] = [];
  private standardQueue: Token[] = [];
  private instantQueue: Token[] = []; // Queue for high technical scores without holder scores
  
  // Track last analysis time for rate limiting
  private lastAnalysisTime = new Map<string, number>();
  
  constructor(config?: Partial<MonitorConfig>) {
    this.analysisService = new OptimizedHolderAnalysisService();
    this.dbPool = getDbPool();
    
    this.config = {
      baseIntervalMs: 10000,           // Check every 10 seconds
      maxConcurrent: 10,                // Max concurrent analyses
      ultraCriticalConcurrent: 5,       // Dedicated slots for ultra-critical
      criticalBatchSize: 5,             // Critical tokens per batch
      standardBatchSize: 10,            // Standard tokens per batch
      ...config
    };
  }
  
  async start(): Promise<void> {
    this.isRunning = true;
    console.log(chalk.red.bold('🚀 ULTRA-FAST Holder Monitor Started'));
    console.log(chalk.gray('━'.repeat(60)));
    console.log(chalk.cyan('Configuration:'));
    console.log(chalk.gray(`  • Base Interval: ${this.config.baseIntervalMs / 1000}s`));
    console.log(chalk.gray(`  • Max Concurrent: ${this.config.maxConcurrent}`));
    console.log(chalk.gray(`  • Ultra-Critical Slots: ${this.config.ultraCriticalConcurrent}`));
    console.log(chalk.gray('━'.repeat(60)));
    
    // Start multiple parallel loops for different tiers
    const loops = [
      this.instantAnalysisLoop(),   // Immediate for high tech scores without holder scores
      this.ultraCriticalLoop(),     // 30-second updates
      this.criticalLoop(),           // 1-minute updates
      this.standardLoop(),           // Variable updates
      this.queueRefreshLoop()        // Refresh queues
    ];
    
    await Promise.all(loops);
  }
  
  async stop(): Promise<void> {
    console.log(chalk.yellow('\n⏹️  Stopping Ultra-Fast Monitor...'));
    this.isRunning = false;
  }
  
  // Instant analysis loop - runs every 5 seconds for high tech scores without holder scores
  private async instantAnalysisLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.processInstantAnalysisTokens();
        await this.sleep(5000); // 5 seconds
      } catch (error) {
        console.error(chalk.red('Error in instant analysis loop:'), error);
        await this.sleep(5000);
      }
    }
  }
  
  // Ultra-critical loop - runs every 10 seconds
  private async ultraCriticalLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.processUltraCriticalTokens();
        await this.sleep(10000); // 10 seconds
      } catch (error) {
        console.error(chalk.red('Error in ultra-critical loop:'), error);
        await this.sleep(10000);
      }
    }
  }
  
  // Critical loop - runs every 30 seconds
  private async criticalLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.processCriticalTokens();
        await this.sleep(30000); // 30 seconds
      } catch (error) {
        console.error(chalk.red('Error in critical loop:'), error);
        await this.sleep(30000);
      }
    }
  }
  
  // Standard loop - runs every minute
  private async standardLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.processStandardTokens();
        await this.sleep(60000); // 60 seconds
      } catch (error) {
        console.error(chalk.red('Error in standard loop:'), error);
        await this.sleep(60000);
      }
    }
  }
  
  // Queue refresh loop - updates token lists
  private async queueRefreshLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.refreshQueues();
        await this.displayRealTimeStats();
        await this.sleep(30000); // Refresh every 30 seconds
      } catch (error) {
        console.error(chalk.red('Error refreshing queues:'), error);
        await this.sleep(30000);
      }
    }
  }
  
  private async processInstantAnalysisTokens(): Promise<void> {
    try {
      // Get tokens requiring instant analysis (high tech score without holder score)
      const result = await this.dbPool.query('SELECT * FROM get_instant_analysis_tokens()');
      
      if (result.rows.length === 0) return;
      
      console.log(chalk.red.bold(`\n⚡ INSTANT ANALYSIS (${result.rows.length} tokens with tech ≥180 missing holder scores)`));
      
      const batch = result.rows.slice(0, 2); // Process only 2 at once to avoid rate limits
      
      const promises = batch.map(async (token: any) => {
        console.log(chalk.yellow.bold(`  🎯 ${token.symbol}: Tech=${token.technical_score} | ${token.reason}`));
        
        const result = await this.analysisService.analyzeToken(
          token.mint_address,
          token.bonding_curve_progress,
          'high'
        );
        
        if (result) {
          // Clear instant flag
          await this.dbPool.query(
            'SELECT clear_instant_analysis_flag($1, $2)',
            [token.token_id, result.score.total]
          );
          
          // Update scores
          await this.dbPool.query(
            'SELECT update_token_scores_and_frequency($1, $2, $3)',
            [token.token_id, 'holder', result.score.total]
          );
          
          const combined = token.technical_score + result.score.total;
          const color = combined >= 500 ? chalk.red.bold : combined >= 400 ? chalk.yellow : chalk.green;
          
          console.log(color(`    ✅ ${token.symbol}: Holder=${result.score.total} | Combined=${combined}/666`));
          
          if (combined >= 500) {
            console.log(chalk.red.bold(`    🔥 ULTRA-CRITICAL: ${token.symbol} reached ${combined}/666!`));
          }
        }
        
        this.lastAnalysisTime.set(token.mint_address, Date.now());
        this.analysisStats.instant++;
        this.analysisStats.total++;
        
        return result;
      });
      
      await Promise.allSettled(promises);
      
    } catch (error) {
      console.error(chalk.red('Error processing instant analysis:'), error);
    }
  }
  
  private async processUltraCriticalTokens(): Promise<void> {
    if (this.ultraCriticalQueue.length === 0) return;
    
    const batch = this.ultraCriticalQueue.splice(0, this.config.ultraCriticalConcurrent);
    
    console.log(chalk.red.bold(`\n🔥 ULTRA-CRITICAL BATCH (${batch.length} tokens)`));
    
    const promises = batch.map(async (token) => {
      // Check rate limit (minimum 30 seconds between analyses)
      const lastTime = this.lastAnalysisTime.get(token.mint_address) || 0;
      if (Date.now() - lastTime < 30000) {
        console.log(chalk.gray(`  ⏭️  ${token.symbol}: Too recent (${Math.floor((Date.now() - lastTime) / 1000)}s ago)`));
        this.ultraCriticalQueue.push(token); // Re-queue
        return null;
      }
      
      console.log(chalk.red(`  🎯 ${token.symbol}: Score ${token.combined_score.toFixed(0)} | Tech ${token.technical_score?.toFixed(0) || 'N/A'} | Hold ${token.holder_score?.toFixed(0) || 'N/A'}`));
      
      const result = await this.analysisService.analyzeToken(
        token.mint_address,
        token.bonding_curve_progress,
        'high'
      );
      
      this.lastAnalysisTime.set(token.mint_address, Date.now());
      this.analysisStats.ultraCritical++;
      this.analysisStats.total++;
      
      if (result) {
        await this.processResult(result, token);
      }
      
      return result;
    });
    
    await Promise.allSettled(promises);
  }
  
  private async processCriticalTokens(): Promise<void> {
    if (this.criticalQueue.length === 0) return;
    
    const batch = this.criticalQueue.splice(0, this.config.criticalBatchSize);
    
    console.log(chalk.yellow.bold(`\n⚡ CRITICAL BATCH (${batch.length} tokens)`));
    
    const promises = batch.map(async (token) => {
      // Check rate limit (minimum 60 seconds between analyses)
      const lastTime = this.lastAnalysisTime.get(token.mint_address) || 0;
      if (Date.now() - lastTime < 60000) {
        this.criticalQueue.push(token); // Re-queue
        return null;
      }
      
      console.log(chalk.yellow(`  📊 ${token.symbol}: Score ${token.combined_score.toFixed(0)}`));
      
      const result = await this.analysisService.analyzeToken(
        token.mint_address,
        token.bonding_curve_progress,
        'high'
      );
      
      this.lastAnalysisTime.set(token.mint_address, Date.now());
      this.analysisStats.critical++;
      this.analysisStats.total++;
      
      if (result) {
        await this.processResult(result, token);
      }
      
      return result;
    });
    
    await Promise.allSettled(promises);
  }
  
  private async processStandardTokens(): Promise<void> {
    const tokens = await this.getStandardTokens();
    if (tokens.length === 0) return;
    
    console.log(chalk.cyan(`\n📈 STANDARD BATCH (${tokens.length} tokens)`));
    
    const promises = tokens.map(async (token) => {
      const priority = this.getPriorityFromTier(token.analysis_tier);
      
      console.log(chalk.gray(`  • ${token.symbol}: ${token.analysis_tier}`));
      
      const result = await this.analysisService.analyzeToken(
        token.mint_address,
        token.bonding_curve_progress,
        priority
      );
      
      this.lastAnalysisTime.set(token.mint_address, Date.now());
      this.analysisStats.standard++;
      this.analysisStats.total++;
      
      if (result) {
        await this.processResult(result, token);
      }
      
      return result;
    });
    
    await Promise.allSettled(promises);
  }
  
  private async refreshQueues(): Promise<void> {
    try {
      // First check for any tokens with high technical scores missing holder scores
      const instantCheck = await this.dbPool.query(`
        UPDATE tokens t
        SET 
          instant_analysis_required = TRUE,
          instant_analysis_reason = 'Tech ' || last_technical_score::TEXT || ' without holder score',
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
      
      if (instantCheck.rows.length > 0) {
        console.log(chalk.yellow.bold(`\n🔍 Found ${instantCheck.rows.length} high-tech tokens needing instant holder analysis`));
      }
      
      // Get ultra-critical and critical tokens
      const result = await this.dbPool.query(`
        SELECT 
          t.id::text as id,
          t.mint_address,
          t.symbol,
          p.bonding_curve_progress,
          t.last_technical_score as technical_score,
          t.last_holder_score as holder_score,
          t.combined_score,
          t.last_holder_analysis as last_analyzed,
          t.holder_score_priority as priority_score,
          t.analysis_tier,
          t.holder_analysis_frequency as recommended_frequency,
          CASE
            WHEN t.combined_score >= 500 THEN 'Exceptional combined score'
            WHEN t.last_technical_score >= 280 THEN 'Technical breakout'
            WHEN p.bonding_curve_progress BETWEEN 75 AND 84 THEN 'Near graduation'
            WHEN t.score_momentum > 30 THEN 'High momentum'
            ELSE 'High priority'
          END as reason
        FROM tokens t
        JOIN pools p ON p.token_id = t.id
        WHERE 
          t.platform = 'pumpfun'
          AND p.status = 'active'
          AND p.bonding_curve_progress BETWEEN 5 AND 84
          AND t.analysis_tier IN ('ultra_critical', 'critical', 'high_priority')
        ORDER BY 
          t.analysis_tier = 'ultra_critical' DESC,
          t.analysis_tier = 'critical' DESC,
          t.combined_score DESC
        LIMIT 100
      `);
      
      // Clear existing queues
      this.ultraCriticalQueue = [];
      this.criticalQueue = [];
      
      // Populate queues based on tier
      for (const row of result.rows) {
        const token: Token = {
          id: row.id,
          mint_address: row.mint_address,
          symbol: row.symbol,
          bonding_curve_progress: parseFloat(row.bonding_curve_progress),
          technical_score: parseFloat(row.technical_score || 0),
          holder_score: parseFloat(row.holder_score || 0),
          combined_score: parseFloat(row.combined_score || 0),
          last_analyzed: row.last_analyzed,
          priority_score: row.priority_score,
          analysis_tier: row.analysis_tier,
          recommended_frequency: row.recommended_frequency,
          reason: row.reason
        };
        
        if (row.analysis_tier === 'ultra_critical') {
          this.ultraCriticalQueue.push(token);
        } else if (row.analysis_tier === 'critical') {
          this.criticalQueue.push(token);
        }
      }
      
    } catch (error) {
      console.error(chalk.red('Error refreshing queues:'), error);
    }
  }
  
  private async getStandardTokens(): Promise<Token[]> {
    try {
      const result = await this.dbPool.query(
        'SELECT * FROM get_tokens_for_analysis_simple()',
        []
      );
      
      return result.rows.map((row: any) => ({
        id: row.token_id,
        mint_address: row.mint_address,
        symbol: row.symbol,
        bonding_curve_progress: parseFloat(row.bonding_curve_progress),
        technical_score: 0,
        holder_score: 0,
        combined_score: 0,
        last_analyzed: null,
        priority_score: row.priority,
        analysis_tier: row.tier,
        recommended_frequency: row.frequency,
        reason: 'Standard analysis'
      }));
      
    } catch (error) {
      console.error(chalk.red('Error fetching standard tokens:'), error);
      return [];
    }
  }
  
  private getPriorityFromTier(tier: string): 'high' | 'medium' | 'low' {
    switch (tier) {
      case 'ultra_critical':
      case 'critical':
      case 'high_priority':
        return 'high';
      case 'elevated':
      case 'standard':
        return 'medium';
      default:
        return 'low';
    }
  }
  
  private async processResult(result: any, token: Token): Promise<void> {
    // Update token scores in database
    await this.dbPool.query(
      `SELECT update_token_scores_and_frequency($1, 'holder', $2)`,
      [token.id, result.score.total]
    );
    
    // Display critical alerts
    for (const alert of result.alerts) {
      if (alert.type === 'CRITICAL' || (alert.type === 'POSITIVE' && result.score.total > 250)) {
        const emoji = 
          alert.type === 'CRITICAL' ? '🚨' :
          alert.type === 'POSITIVE' ? '✅' : 'ℹ️';
        
        const color = 
          alert.type === 'CRITICAL' ? chalk.red :
          alert.type === 'POSITIVE' ? chalk.green : chalk.gray;
        
        console.log(color(`    ${emoji} ${token.symbol}: ${alert.message}`));
      }
    }
  }
  
  private async displayRealTimeStats(): Promise<void> {
    const runtime = Math.floor((Date.now() - this.analysisStats.startTime.getTime()) / 1000);
    const minutes = Math.floor(runtime / 60);
    const seconds = runtime % 60;
    
    // Get current queue sizes
    const queueStats = {
      ultraCritical: this.ultraCriticalQueue.length,
      critical: this.criticalQueue.length,
      total: this.ultraCriticalQueue.length + this.criticalQueue.length
    };
    
    // Calculate analysis rate
    const analysisRate = runtime > 0 ? (this.analysisStats.total / runtime * 60).toFixed(1) : '0';
    
    // Get cache stats
    const cacheStats = await this.analysisService.getCacheStats();
    
    console.log(chalk.cyan('\n📊 REAL-TIME STATS'));
    console.log(chalk.gray('━'.repeat(60)));
    console.log(chalk.white(`Runtime: ${minutes}m ${seconds}s | Analysis Rate: ${analysisRate}/min`));
    console.log(chalk.yellow.bold(`⚡ Instant (Tech≥180): ${this.analysisStats.instant} analyzed`));
    console.log(chalk.red(`🔥 Ultra-Critical: ${this.analysisStats.ultraCritical} analyzed | ${queueStats.ultraCritical} queued`));
    console.log(chalk.yellow(`⚡ Critical: ${this.analysisStats.critical} analyzed | ${queueStats.critical} queued`));
    console.log(chalk.cyan(`📈 Standard: ${this.analysisStats.standard} analyzed`));
    console.log(chalk.green(`✅ Total: ${this.analysisStats.total} tokens analyzed`));
    console.log(chalk.gray(`💾 Cache: ${(cacheStats.hitRate * 100).toFixed(1)}% hit rate | ${cacheStats.sizes.hot + cacheStats.sizes.warm + cacheStats.sizes.cold + cacheStats.sizes.permanent} entries`));
    
    // Display top ultra-critical tokens
    if (this.ultraCriticalQueue.length > 0) {
      console.log(chalk.red.bold('\n🎯 TOP ULTRA-CRITICAL TOKENS:'));
      const topTokens = this.ultraCriticalQueue.slice(0, 3);
      for (const token of topTokens) {
        console.log(chalk.red(`  ${token.symbol}: ${token.combined_score.toFixed(0)} pts | ${token.reason}`));
      }
    }
    
    console.log(chalk.gray('━'.repeat(60)));
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Standalone runner
async function runUltraFastMonitor() {
  const monitor = new UltraFastHolderMonitor({
    baseIntervalMs: 10000,           // Check every 10 seconds
    maxConcurrent: 10,                // 10 concurrent analyses
    ultraCriticalConcurrent: 5,       // 5 dedicated ultra-critical slots
    criticalBatchSize: 5,             // 5 critical tokens per batch
    standardBatchSize: 10             // 10 standard tokens per batch
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
export { runUltraFastMonitor };

// Run if executed directly
if (require.main === module) {
  runUltraFastMonitor().catch(error => {
    console.error(chalk.red('Failed to start ultra-fast monitor:'), error);
    process.exit(1);
  });
}