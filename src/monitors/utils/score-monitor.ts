#!/usr/bin/env node
import { getDbPool } from '../../database/connection';
import chalk from 'chalk';

/**
 * Simple Technical Score Monitor - Working Version
 * Displays real-time technical scores with sell-off detection
 */

class SimpleScoreMonitor {
  private pool = getDbPool();
  private updateInterval: number = 5000; // 5 seconds
  
  async start() {
    console.log(chalk.cyan('🚀 Starting Simple Technical Score Monitor'));
    console.log(chalk.gray('━'.repeat(80)));
    
    // Start monitoring loop
    await this.monitorLoop();
  }
  
  private async monitorLoop() {
    while (true) {
      try {
        await this.displayScores();
      } catch (error) {
        console.error(chalk.red('Error:'), error);
      }
      
      await new Promise(resolve => setTimeout(resolve, this.updateInterval));
    }
  }
  
  private async displayScores() {
    const client = await this.pool.connect();
    try {
      // Get tokens with recent activity and calculate scores
      const result = await client.query(`
        WITH active_tokens AS (
          SELECT DISTINCT 
            t.id as token_id,
            p.id as pool_id,
            t.symbol,
            t.name,
            p.latest_price_usd,
            p.bonding_curve_progress
          FROM tokens t
          JOIN pools p ON t.id = p.token_id
          WHERE t.platform = 'pumpfun'
          AND p.status = 'active'
          AND EXISTS (
            SELECT 1 FROM transactions tx
            WHERE tx.pool_id = p.id
            AND tx.block_time > NOW() - INTERVAL '30 minutes'
          )
          LIMIT 15
        ),
        scores AS (
          SELECT 
            at.*,
            ts.total_score,
            ts.market_cap_score,
            ts.bonding_curve_score,
            ts.trading_health_score,
            ts.selloff_response_score,
            ts.market_cap_usd,
            ts.buy_sell_ratio,
            ts.is_selloff_active
          FROM active_tokens at
          CROSS JOIN LATERAL calculate_technical_score_v2(at.token_id, at.pool_id) ts
        )
        SELECT * FROM scores
        ORDER BY total_score DESC
      `);
      
      // Clear console and display header
      console.clear();
      console.log(chalk.cyan.bold('📊 Technical Score Monitor'));
      console.log(chalk.gray('━'.repeat(80)));
      console.log(chalk.gray('Updated: ' + new Date().toLocaleTimeString()));
      console.log();
      
      // Display column headers
      console.log(
        chalk.gray(
          'Symbol'.padEnd(10) +
          'Score'.padEnd(8) +
          'MCap'.padEnd(10) +
          'Progress'.padEnd(10) +
          'Buy/Sell'.padEnd(10) +
          'Components (MC/BC/TH/SR)'.padEnd(28) +
          'Status'
        )
      );
      console.log(chalk.gray('─'.repeat(80)));
      
      // Display each token
      for (const row of result.rows) {
        const score = parseFloat(row.total_score || 0);
        const marketCap = parseFloat(row.market_cap_usd || 0);
        const progress = parseFloat(row.bonding_curve_progress || 0);
        const buySellRatio = parseFloat(row.buy_sell_ratio || 1);
        const isSelloff = row.is_selloff_active;
        
        // Color coding
        const scoreColor = score > 250 ? chalk.green :
                          score > 150 ? chalk.yellow :
                          score > 100 ? chalk.white :
                          chalk.red;
        
        const status = isSelloff ? chalk.red('⚠️ SELL-OFF') :
                      score > 200 ? chalk.green('✅ BULLISH') :
                      score > 100 ? chalk.yellow('→ NEUTRAL') :
                      chalk.red('❌ BEARISH');
        
        // Component scores
        const components = `${parseFloat(row.market_cap_score || 0).toFixed(0)}/${parseFloat(row.bonding_curve_score || 0).toFixed(0)}/${parseFloat(row.trading_health_score || 0).toFixed(0)}/${parseFloat(row.selloff_response_score || 0).toFixed(0)}`;
        
        console.log(
          chalk.white(row.symbol.substring(0, 9).padEnd(10)) +
          scoreColor(score.toFixed(1).padEnd(8)) +
          chalk.white(`$${(marketCap / 1000).toFixed(1)}k`.padEnd(10)) +
          chalk.cyan(`${progress.toFixed(1)}%`.padEnd(10)) +
          chalk.blue(`${buySellRatio.toFixed(2)}x`.padEnd(10)) +
          chalk.gray(components.padEnd(28)) +
          status
        );
      }
      
      // Display market summary
      const summaryResult = await client.query(`
        WITH recent_scores AS (
          SELECT 
            token_id,
            total_score,
            is_selloff_active
          FROM (
            SELECT DISTINCT ON (p.token_id)
              p.token_id,
              ts.total_score,
              ts.is_selloff_active
            FROM pools p
            CROSS JOIN LATERAL calculate_technical_score_v2(p.token_id, p.id) ts
            WHERE p.status = 'active'
            AND EXISTS (
              SELECT 1 FROM transactions tx
              WHERE tx.pool_id = p.id
              AND tx.block_time > NOW() - INTERVAL '1 hour'
            )
            ORDER BY p.token_id, p.updated_at DESC
          ) t
        )
        SELECT 
          COUNT(CASE WHEN total_score > 200 THEN 1 END) as bullish,
          COUNT(CASE WHEN total_score < 100 THEN 1 END) as bearish,
          COUNT(CASE WHEN total_score BETWEEN 100 AND 200 THEN 1 END) as neutral,
          COUNT(CASE WHEN is_selloff_active THEN 1 END) as selloffs,
          AVG(total_score) as avg_score
        FROM recent_scores
      `);
      
      const summary = summaryResult.rows[0];
      console.log(chalk.gray('\n' + '━'.repeat(80)));
      console.log(chalk.cyan.bold('Market Summary:'));
      console.log(
        chalk.green(`Bullish: ${summary.bullish || 0}`) + '  ' +
        chalk.red(`Bearish: ${summary.bearish || 0}`) + '  ' +
        chalk.gray(`Neutral: ${summary.neutral || 0}`) + '  ' +
        chalk.yellow(`Active Sell-offs: ${summary.selloffs || 0}`) + '  ' +
        chalk.white(`Avg Score: ${parseFloat(summary.avg_score || 0).toFixed(1)}`)
      );
      
    } finally {
      client.release();
    }
  }
}

// Start the monitor
const monitor = new SimpleScoreMonitor();
monitor.start().catch(console.error);