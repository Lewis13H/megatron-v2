import { HolderAnalysisServiceV3, AnalysisResult, QuickScoreResult } from '../services/holder-analysis/holder-analysis-service-v3';
import { getDbPool } from '../database/connection';
import { monitorService } from '../database';
import chalk from 'chalk';
import { EventEmitter } from 'events';

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
  priorityThreshold: number;  // SOL amount that triggers priority analysis
  technicalScoreThreshold: number;  // Technical score that triggers analysis
}

interface PriorityToken {
  mint: string;
  reason: 'large_transaction' | 'technical_score' | 'whale_entry' | 'volume_surge';
  priority: number;
  timestamp: number;
}

export class HolderMonitorV3 extends EventEmitter {
  private analysisService: HolderAnalysisServiceV3;
  private dbPool: any;
  private isRunning = false;
  private config: MonitorConfig;
  private analysisCount = 0;
  private startTime: Date;
  private priorityQueue: Map<string, PriorityToken> = new Map();
  private lastAnalysis: Map<string, number> = new Map();
  
  constructor(config?: Partial<MonitorConfig>) {
    super();
    this.analysisService = new HolderAnalysisServiceV3();
    this.dbPool = getDbPool();
    this.startTime = new Date();
    
    // Default config optimized for responsive analysis
    this.config = {
      intervalMs: 30000,      // 30 seconds for priority tokens
      batchSize: 10,          // Analyze 10 tokens per batch
      maxConcurrent: 5,       // 5 concurrent analyses
      minProgress: 5,         // Min 5% bonding curve
      maxProgress: 70,        // Max 70% bonding curve
      priorityThreshold: 3,   // 3 SOL triggers priority
      technicalScoreThreshold: 250, // High technical score triggers
      ...config
    };
    
    // Subscribe to transaction events
    this.subscribeToEvents();
  }
  
  private subscribeToEvents(): void {
    console.log(chalk.cyan('📡 Subscribing to transaction events...'));
    
    // Subscribe to existing monitor events if available
    // Note: monitorService event subscription would go here if it supported events
    // For now, we'll rely on database polling
    
    // Subscribe to database triggers for real-time events
    this.setupDatabaseTriggers();
  }
  
  private async setupDatabaseTriggers(): Promise<void> {
    try {
      // Poll for large transactions every 10 seconds
      setInterval(async () => {
        if (!this.isRunning) return;
        
        const largeTransactions = await this.dbPool.query(`
          SELECT DISTINCT 
            t.mint_address,
            tx.sol_amount,
            tx.type,
            tx.block_time
          FROM transactions tx
          JOIN tokens t ON tx.token_id = t.id
          JOIN pools p ON t.id = p.token_id
          WHERE tx.sol_amount >= $1
            AND tx.block_time > NOW() - INTERVAL '1 minute'
            AND p.bonding_curve_progress BETWEEN $2 AND $3
            AND p.status = 'active'
          ORDER BY tx.sol_amount DESC
          LIMIT 5
        `, [this.config.priorityThreshold, this.config.minProgress, this.config.maxProgress]);
        
        for (const row of largeTransactions.rows) {
          await this.addToPriorityQueue(row.mint_address, 'large_transaction', 90);
        }
      }, 10000);
      
      // Poll for high technical scores every 15 seconds
      setInterval(async () => {
        if (!this.isRunning) return;
        
        const highScores = await this.dbPool.query(`
          SELECT DISTINCT
            ts.token_address,
            ts.total_score,
            ts.bonding_curve_score
          FROM technical_scores ts
          JOIN tokens t ON ts.token_address = t.mint_address
          JOIN pools p ON t.id = p.token_id
          WHERE ts.total_score >= $1
            AND ts.created_at > NOW() - INTERVAL '2 minutes'
            AND p.bonding_curve_progress BETWEEN $2 AND $3
            AND p.status = 'active'
          ORDER BY ts.total_score DESC
          LIMIT 5
        `, [this.config.technicalScoreThreshold, this.config.minProgress, this.config.maxProgress]);
        
        for (const row of highScores.rows) {
          await this.addToPriorityQueue(row.token_address, 'technical_score', 85);
        }
      }, 15000);
      
    } catch (error) {
      console.error(chalk.red('Error setting up database triggers:'), error);
    }
  }
  
  private async handleLargeTransaction(data: any): Promise<void> {
    const { token, amount, type } = data;
    
    if (amount >= this.config.priorityThreshold) {
      console.log(chalk.yellow(`⚡ Large ${type}: ${amount.toFixed(2)} SOL on ${token}`));
      await this.addToPriorityQueue(token, 'large_transaction', 95);
    }
  }
  
  private async handleTechnicalScoreUpdate(data: any): Promise<void> {
    const { token, score, deltaScore } = data;
    
    if (score >= this.config.technicalScoreThreshold || deltaScore > 50) {
      console.log(chalk.yellow(`📈 High technical score: ${score} on ${token}`));
      await this.addToPriorityQueue(token, 'technical_score', 90);
    }
  }
  
  private async addToPriorityQueue(
    mint: string, 
    reason: PriorityToken['reason'], 
    priority: number
  ): Promise<void> {
    // Check if recently analyzed
    const lastTime = this.lastAnalysis.get(mint);
    if (lastTime && Date.now() - lastTime < 300000) { // 5 minutes cooldown
      return;
    }
    
    // Add or update priority
    const existing = this.priorityQueue.get(mint);
    if (!existing || existing.priority < priority) {
      this.priorityQueue.set(mint, {
        mint,
        reason,
        priority,
        timestamp: Date.now()
      });
      
      console.log(chalk.magenta(`🎯 Added to priority queue: ${mint} (${reason}, priority: ${priority})`));
    }
  }
  
  async start(): Promise<void> {
    this.isRunning = true;
    console.log(chalk.green('🚀 Holder Monitor V3 Started'));
    console.log(chalk.gray('━'.repeat(50)));
    console.log(chalk.cyan('Configuration:'));
    console.log(chalk.gray(`  • Interval: ${this.config.intervalMs / 1000}s`));
    console.log(chalk.gray(`  • Batch Size: ${this.config.batchSize} tokens`));
    console.log(chalk.gray(`  • Progress Range: ${this.config.minProgress}-${this.config.maxProgress}%`));
    console.log(chalk.gray(`  • Priority Threshold: ${this.config.priorityThreshold} SOL`));
    console.log(chalk.gray(`  • Technical Threshold: ${this.config.technicalScoreThreshold}`));
    console.log(chalk.gray('━'.repeat(50)));
    
    // Initial stats display
    await this.displayStats();
    
    // Main loop
    while (this.isRunning) {
      try {
        await this.runAnalysisCycle();
        
        // Shorter interval for priority tokens
        const hasPriority = this.priorityQueue.size > 0;
        const interval = hasPriority ? 10000 : this.config.intervalMs;
        
        await this.sleep(interval);
        
      } catch (error) {
        console.error(chalk.red('Error in analysis cycle:'), error);
        await this.sleep(this.config.intervalMs);
      }
    }
  }
  
  async stop(): Promise<void> {
    console.log(chalk.yellow('\n⏹️  Stopping Holder Monitor V3...'));
    this.isRunning = false;
  }
  
  private async runAnalysisCycle(): Promise<void> {
    // Process priority queue first
    if (this.priorityQueue.size > 0) {
      await this.processPriorityQueue();
    }
    
    // Then get regular tokens for analysis
    const tokens = await this.getTokensForAnalysis();
    if (tokens.length === 0) {
      return;
    }
    
    console.log(chalk.blue(`\n📊 Analyzing ${tokens.length} tokens...`));
    
    // Analyze tokens with concurrency control
    const results = await this.batchAnalyze(tokens, this.config.maxConcurrent);
    
    // Process results
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        await this.processResult(result.value);
        this.analysisCount++;
      }
    }
    
    // Display periodic stats
    if (this.analysisCount % 10 === 0) {
      await this.displayStats();
    }
  }
  
  private async processPriorityQueue(): Promise<void> {
    // Sort by priority and take top N
    const sorted = Array.from(this.priorityQueue.values())
      .sort((a, b) => b.priority - a.priority)
      .slice(0, this.config.maxConcurrent);
    
    console.log(chalk.yellow(`\n⚡ Processing ${sorted.length} priority tokens...`));
    
    for (const item of sorted) {
      try {
        // Quick score first
        const quickScore = await this.analysisService.getQuickScore(item.mint);
        
        if (quickScore) {
          console.log(chalk.cyan(
            `  Quick score for ${item.mint}: ${quickScore.score}/50 ` +
            `(confidence: ${quickScore.confidence})`
          ));
          
          // Deep analysis if warranted
          if (quickScore.shouldDeepAnalyze) {
            const bondingProgress = await this.getBondingProgress(item.mint);
            if (bondingProgress) {
              const result = await this.analysisService.analyzeToken(item.mint, bondingProgress);
              if (result) {
                await this.processResult(result);
              }
            }
          }
        }
        
        // Remove from queue and update last analysis time
        this.priorityQueue.delete(item.mint);
        this.lastAnalysis.set(item.mint, Date.now());
        
      } catch (error) {
        console.error(chalk.red(`Error analyzing priority token ${item.mint}:`), error);
      }
    }
  }
  
  private async getBondingProgress(mint: string): Promise<number | null> {
    try {
      const result = await this.dbPool.query(`
        SELECT p.bonding_curve_progress
        FROM pools p
        JOIN tokens t ON p.token_id = t.id
        WHERE t.mint_address = $1
        LIMIT 1
      `, [mint]);
      
      return result.rows[0]?.bonding_curve_progress || null;
    } catch (error) {
      console.error('Error fetching bonding progress:', error);
      return null;
    }
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
      console.error(chalk.red('Error getting tokens for analysis:'), error);
      return [];
    }
  }
  
  private async batchAnalyze(tokens: Token[], concurrency: number): Promise<PromiseSettledResult<AnalysisResult | null>[]> {
    const results: PromiseSettledResult<AnalysisResult | null>[] = [];
    
    for (let i = 0; i < tokens.length; i += concurrency) {
      const batch = tokens.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(t => this.analysisService.analyzeToken(
          t.mint_address,
          t.bonding_curve_progress
        ))
      );
      results.push(...batchResults);
    }
    
    return results;
  }
  
  private async processResult(result: AnalysisResult): Promise<void> {
    // Emit events for critical alerts
    for (const alert of result.alerts) {
      if (alert.type === 'CRITICAL') {
        this.emit('critical_alert', {
          token: result.token.mint,
          alert: alert.message,
          score: result.score.total
        });
      }
      
      if (alert.type === 'POSITIVE' && result.score.total > 250) {
        this.emit('high_score', {
          token: result.token.mint,
          score: result.score.total,
          alerts: result.alerts
        });
      }
    }
    
    // Log summary
    const emoji = result.score.total > 250 ? '🌟' : 
                  result.score.total > 150 ? '✅' : '⚠️';
    
    console.log(
      chalk.green(`${emoji} ${result.token.mint?.slice(0, 8) || 'Unknown'}: `) +
      chalk.white(`Score: ${result.score.total}/333 `) +
      chalk.gray(`(D:${result.score.distribution} Q:${result.score.quality} A:${result.score.activity})`)
    );
    
    // Log alerts
    for (const alert of result.alerts) {
      const color = alert.type === 'CRITICAL' ? chalk.red :
                    alert.type === 'WARNING' ? chalk.yellow :
                    alert.type === 'POSITIVE' ? chalk.green : chalk.gray;
      console.log(color(`    ${alert.message}`));
    }
  }
  
  private async displayStats(): Promise<void> {
    const runtime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    const hours = Math.floor(runtime / 3600);
    const minutes = Math.floor((runtime % 3600) / 60);
    
    console.log(chalk.gray('\n' + '─'.repeat(50)));
    console.log(chalk.cyan('📊 Monitor Statistics:'));
    console.log(chalk.gray(`  • Analyses completed: ${this.analysisCount}`));
    console.log(chalk.gray(`  • Priority queue size: ${this.priorityQueue.size}`));
    console.log(chalk.gray(`  • Runtime: ${hours}h ${minutes}m`));
    console.log(chalk.gray('─'.repeat(50) + '\n'));
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  // Public methods for external control
  public async analyzeToken(mint: string, priority: number = 50): Promise<AnalysisResult | null> {
    await this.addToPriorityQueue(mint, 'large_transaction', priority);
    return null;
  }
  
  public getQueueStatus(): { size: number; tokens: string[] } {
    return {
      size: this.priorityQueue.size,
      tokens: Array.from(this.priorityQueue.keys())
    };
  }
}

// Export a function to start the monitor
export async function startHolderMonitorV3(config?: Partial<MonitorConfig>): Promise<HolderMonitorV3> {
  const monitor = new HolderMonitorV3(config);
  
  // Start in background
  monitor.start().catch(error => {
    console.error(chalk.red('Fatal error in Holder Monitor V3:'), error);
    process.exit(1);
  });
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n📊 Shutting down Holder Monitor V3...'));
    await monitor.stop();
    process.exit(0);
  });
  
  return monitor;
}

// If run directly
if (require.main === module) {
  startHolderMonitorV3();
}