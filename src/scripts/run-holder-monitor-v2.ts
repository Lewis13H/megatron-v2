#!/usr/bin/env npx tsx
/**
 * Production Holder Monitor V2 Runner
 * Optimized for Helius Developer Plan (10M credits/month)
 * 
 * Usage:
 *   npm run holder:monitor:v2
 *   npx tsx src/scripts/run-holder-monitor-v2.ts
 * 
 * Environment Variables:
 *   HELIUS_API_KEY - Your Helius API key (required)
 *   HOLDER_MIN_PROGRESS - Minimum bonding curve progress (default: 10)
 *   HOLDER_MAX_PROGRESS - Maximum bonding curve progress (default: 99)
 *   HOLDER_WEBSOCKET - Enable WebSocket monitoring (default: false)
 *   HOLDER_INTERVAL_MS - Analysis interval in ms (default: 60000)
 */

import dotenv from 'dotenv';
import { startHolderMonitorV2, HolderMonitorV2 } from '../monitors/holder-monitor-v2';
import { getDbPool } from '../database/connection';
import chalk from 'chalk';

// Load environment variables
dotenv.config();

// Validate environment
if (!process.env.HELIUS_API_KEY) {
  console.error(chalk.red('❌ HELIUS_API_KEY environment variable is required'));
  process.exit(1);
}

// Configuration
const config = {
  heliusApiKey: process.env.HELIUS_API_KEY,
  enableWebSocket: process.env.HOLDER_WEBSOCKET === 'true',
  analysisIntervalMs: parseInt(process.env.HOLDER_INTERVAL_MS || '60000'),
  minBondingCurveProgress: parseInt(process.env.HOLDER_MIN_PROGRESS || '10'),
  maxBondingCurveProgress: parseInt(process.env.HOLDER_MAX_PROGRESS || '99'),
  minHolders: 5,
  minTokenAgeMinutes: 30,
  maxConcurrentAnalysis: 5,
  alertThresholds: {
    highConcentration: 50,
    highBotRatio: 0.3,
    highGini: 0.8,
    lowScore: 100,
    highScore: 250,
    highRisk: 70
  }
};

let monitor: HolderMonitorV2 | null = null;

// ============================================
// Main Function
// ============================================

async function main() {
  console.log(chalk.cyan('╔════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('║         Megatron V2 - Holder Analysis Monitor V2          ║'));
  console.log(chalk.cyan('║              Optimized for Helius Developer Plan          ║'));
  console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝'));
  console.log();

  // Test database connection
  try {
    const db = getDbPool();
    await db.query('SELECT NOW()');
    console.log(chalk.green('✅ Database connected'));
  } catch (error) {
    console.error(chalk.red('❌ Database connection failed:'), error);
    process.exit(1);
  }

  // Display configuration
  console.log(chalk.yellow('\n📋 Configuration:'));
  console.log(`  API Key: ${config.heliusApiKey.substring(0, 8)}...`);
  console.log(`  WebSocket: ${config.enableWebSocket ? 'Enabled' : 'Disabled'}`);
  console.log(`  Analysis Interval: ${config.analysisIntervalMs}ms`);
  console.log(`  Bonding Curve Range: ${config.minBondingCurveProgress}-${config.maxBondingCurveProgress}%`);
  console.log(`  Min Token Age: ${config.minTokenAgeMinutes} minutes`);
  console.log(`  Max Concurrent: ${config.maxConcurrentAnalysis}`);
  console.log();

  // Start monitor
  try {
    console.log(chalk.yellow('🚀 Starting holder monitor...'));
    monitor = await startHolderMonitorV2(config);

    // Setup event listeners
    setupEventListeners(monitor);

    // Display initial statistics
    await displayStatistics(monitor);

    console.log(chalk.green('\n✅ Holder monitor running successfully'));
    console.log(chalk.gray('Press Ctrl+C to stop\n'));

    // Display periodic statistics
    setInterval(async () => {
      await displayStatistics(monitor!);
    }, 5 * 60 * 1000); // Every 5 minutes

  } catch (error) {
    console.error(chalk.red('❌ Failed to start monitor:'), error);
    process.exit(1);
  }
}

// ============================================
// Event Handlers
// ============================================

function setupEventListeners(monitor: HolderMonitorV2) {
  // Analysis complete
  monitor.on('analyzed', (result) => {
    const { token, score, metrics, alerts } = result;
    
    // Color-coded score
    let scoreColor = chalk.red;
    if (score.total > 250) scoreColor = chalk.green;
    else if (score.total > 180) scoreColor = chalk.yellow;
    
    console.log(
      chalk.blue(`[${new Date().toISOString()}]`),
      chalk.white(`${token.symbol}`),
      scoreColor(`Score: ${score.total}/333`),
      chalk.gray(`(D:${score.distribution} Q:${score.quality} A:${score.activity})`),
      chalk.cyan(`Holders: ${metrics.holderCount}`),
      chalk.magenta(`Risk: ${metrics.overallRisk}/100`)
    );

    // Display alerts
    if (alerts.length > 0) {
      alerts.forEach(alert => {
        const icon = alert.level === 'critical' ? '🚨' : 
                    alert.level === 'warning' ? '⚠️' : 'ℹ️';
        const color = alert.level === 'critical' ? chalk.red :
                      alert.level === 'warning' ? chalk.yellow : chalk.cyan;
        console.log(`  ${icon} ${color(alert.message)}`);
      });
    }
  });

  // Critical alerts
  monitor.on('criticalAlert', (result) => {
    const { token, alerts } = result;
    console.log(chalk.red.bold(`\n🚨🚨🚨 CRITICAL ALERT for ${token.symbol} 🚨🚨🚨`));
    alerts
      .filter(a => a.level === 'critical')
      .forEach(alert => {
        console.log(chalk.red(`  ➤ ${alert.message}`));
      });
    console.log();
  });

  // Errors
  monitor.on('analysisError', ({ token, error }) => {
    console.error(
      chalk.red(`[ERROR]`),
      chalk.white(`Failed to analyze ${token.symbol}:`),
      error.message || error
    );
  });

  // Credit warnings
  monitor.on('creditWarning', (data) => {
    console.log(chalk.yellow.bold('\n⚠️  API CREDIT WARNING ⚠️'));
    console.log(chalk.yellow(`  Used: ${data.used.toLocaleString()}`));
    console.log(chalk.yellow(`  Projected Monthly: ${data.projected.toLocaleString()}`));
    console.log(chalk.yellow(`  Limit: ${data.limit.toLocaleString()}`));
    console.log(chalk.yellow(`  Usage: ${((data.projected / data.limit) * 100).toFixed(2)}%\n`));
  });

  // Holder updates from WebSocket
  monitor.on('holderUpdate', (data) => {
    console.log(
      chalk.gray(`[WS Update]`),
      chalk.white(`${data.mintAddress.substring(0, 8)}...`),
      chalk.cyan('Holder data updated')
    );
  });
}

// ============================================
// Statistics Display
// ============================================

async function displayStatistics(monitor: HolderMonitorV2) {
  try {
    const db = getDbPool();
    
    // Get statistics
    const statsQuery = `
      WITH recent_scores AS (
        SELECT 
          COUNT(*) as total_analyzed,
          AVG(total_score) as avg_score,
          MAX(total_score) as max_score,
          MIN(total_score) as min_score,
          AVG(gini_coefficient) as avg_gini,
          AVG(bot_ratio) as avg_bot_ratio,
          COUNT(CASE WHEN total_score > 250 THEN 1 END) as high_score_count,
          COUNT(CASE WHEN total_score < 100 THEN 1 END) as low_score_count
        FROM holder_scores
        WHERE score_time > NOW() - INTERVAL '1 hour'
      ),
      top_tokens AS (
        SELECT 
          t.symbol,
          hs.total_score
        FROM holder_scores hs
        JOIN tokens t ON hs.token_id = t.id
        WHERE hs.score_time > NOW() - INTERVAL '1 hour'
        ORDER BY hs.total_score DESC
        LIMIT 3
      )
      SELECT 
        rs.*,
        (SELECT json_agg(tt.*) FROM top_tokens tt) as top_tokens
      FROM recent_scores rs
    `;

    const result = await db.query(statsQuery);
    const stats = result.rows[0];

    // Get credit usage
    const creditsUsed = monitor.getCreditsUsed();
    const dailyProjection = creditsUsed * (24 * 60 / (Date.now() / (1000 * 60)));
    const monthlyProjection = dailyProjection * 30;

    // Display statistics
    console.log(chalk.cyan('\n📊 Statistics (Last Hour):'));
    console.log(chalk.white('─'.repeat(50)));
    
    if (stats && stats.total_analyzed > 0) {
      console.log(`  Tokens Analyzed: ${stats.total_analyzed}`);
      console.log(`  Average Score: ${Math.round(stats.avg_score || 0)}/333`);
      console.log(`  Score Range: ${Math.round(stats.min_score || 0)}-${Math.round(stats.max_score || 0)}`);
      console.log(`  High Scores (>250): ${stats.high_score_count || 0}`);
      console.log(`  Low Scores (<100): ${stats.low_score_count || 0}`);
      console.log(`  Avg Gini: ${(stats.avg_gini || 0).toFixed(3)}`);
      console.log(`  Avg Bot Ratio: ${((stats.avg_bot_ratio || 0) * 100).toFixed(1)}%`);
      
      if (stats.top_tokens && stats.top_tokens.length > 0) {
        console.log(chalk.green('\n  🏆 Top Tokens:'));
        stats.top_tokens.forEach((token: any, index: number) => {
          console.log(`    ${index + 1}. ${token.symbol}: ${Math.round(token.total_score)}/333`);
        });
      }
    } else {
      console.log(chalk.gray('  No tokens analyzed in the last hour'));
    }

    // API usage
    console.log(chalk.yellow('\n💳 API Credits:'));
    console.log(chalk.white('─'.repeat(50)));
    console.log(`  Session Used: ${creditsUsed.toLocaleString()}`);
    console.log(`  Monthly Projection: ${Math.round(monthlyProjection).toLocaleString()}`);
    console.log(`  Monthly Limit: 10,000,000`);
    console.log(`  Usage: ${((monthlyProjection / 10_000_000) * 100).toFixed(2)}%`);
    
    if (monthlyProjection > 8_000_000) {
      console.log(chalk.red.bold('  ⚠️  WARNING: Approaching monthly limit!'));
    } else if (monthlyProjection < 1_000_000) {
      console.log(chalk.green('  ✅ Credit usage well within limits'));
    }

    // Active analysis
    const activeTokens = monitor.getActiveAnalysis();
    if (activeTokens.length > 0) {
      console.log(chalk.magenta(`\n🔄 Currently Analyzing: ${activeTokens.length} tokens`));
    }

  } catch (error) {
    console.error(chalk.red('Failed to display statistics:'), error);
  }
}

// ============================================
// Graceful Shutdown
// ============================================

async function shutdown() {
  console.log(chalk.yellow('\n\n🛑 Shutting down holder monitor...'));
  
  if (monitor) {
    await monitor.stop();
  }
  
  // Close database connection
  const db = getDbPool();
  await db.end();
  
  console.log(chalk.green('✅ Shutdown complete'));
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error(chalk.red('Uncaught Exception:'), error);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('Unhandled Rejection at:'), promise, chalk.red('reason:'), reason);
  shutdown();
});

// ============================================
// Run
// ============================================

main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});