import dotenv from 'dotenv';
import { startHolderSnapshotService, HolderSnapshotService } from '../services/holder-snapshot-service';
import { getDbPool } from '../database/connection';

dotenv.config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const RPC_URL = process.env.RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const INTERVAL_MINUTES = parseInt(process.env.HOLDER_SCORE_INTERVAL || '5');

let service: HolderSnapshotService | null = null;

/**
 * Main function to start the holder score monitoring service
 */
async function main() {
  console.log('🚀 Starting Holder Score Monitoring Service');
  console.log(`📊 Analysis window: 10-25% bonding curve progress`);
  console.log(`⏱️  Check interval: ${INTERVAL_MINUTES} minutes`);
  console.log('');

  if (!HELIUS_API_KEY) {
    console.error('❌ HELIUS_API_KEY environment variable is required');
    process.exit(1);
  }

  try {
    // Test database connection
    const pool = getDbPool();
    await pool.query('SELECT 1');
    console.log('✅ Database connection established');

    // Start the holder snapshot service
    service = await startHolderSnapshotService(HELIUS_API_KEY, RPC_URL, INTERVAL_MINUTES);
    console.log('✅ Holder snapshot service started');
    console.log('');
    
    // Display initial statistics
    await displayStatistics();

    // Set up periodic statistics display
    setInterval(displayStatistics, 60000); // Every minute

    // Keep the process running
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    console.error('❌ Failed to start holder monitoring service:', error);
    process.exit(1);
  }
}

/**
 * Display current statistics
 */
async function displayStatistics() {
  try {
    const pool = getDbPool();
    
    // Get eligible tokens count
    const eligibleResult = await pool.query(`
      SELECT COUNT(*) as count
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE p.platform = 'pumpfun'
        AND p.bonding_curve_progress >= 10
        AND p.bonding_curve_progress <= 25
        AND p.status = 'active'
    `);
    
    // Get recent scores
    const recentScoresResult = await pool.query(`
      SELECT 
        COUNT(*) as count,
        AVG(total_score) as avg_score,
        MAX(total_score) as max_score,
        MIN(total_score) as min_score
      FROM holder_scores
      WHERE score_time > NOW() - INTERVAL '1 hour'
    `);
    
    // Get top scored tokens
    const topTokensResult = await pool.query(`
      SELECT 
        t.symbol,
        t.name,
        hs.total_score,
        hs.bonding_curve_progress,
        hs.unique_holders,
        hs.gini_coefficient,
        hs.bot_ratio
      FROM holder_scores hs
      JOIN tokens t ON hs.token_id = t.id
      WHERE hs.score_time > NOW() - INTERVAL '24 hours'
      ORDER BY hs.total_score DESC
      LIMIT 5
    `);
    
    const eligible = eligibleResult.rows[0].count;
    const recentScores = recentScoresResult.rows[0];
    
    console.log('\n📊 HOLDER SCORE STATISTICS');
    console.log('═'.repeat(50));
    console.log(`Eligible tokens (10-25% progress): ${eligible}`);
    console.log(`Scores calculated (last hour): ${recentScores.count || 0}`);
    
    if (recentScores.count > 0) {
      console.log(`Average score: ${(recentScores.avg_score || 0).toFixed(0)}/333`);
      console.log(`Best score: ${recentScores.max_score || 0}/333`);
      console.log(`Worst score: ${recentScores.min_score || 0}/333`);
    }
    
    if (topTokensResult.rows.length > 0) {
      console.log('\n🏆 TOP SCORED TOKENS (24h)');
      console.log('─'.repeat(50));
      topTokensResult.rows.forEach((token, index) => {
        console.log(`${index + 1}. ${token.symbol} - ${token.total_score}/333`);
        console.log(`   Progress: ${token.bonding_curve_progress.toFixed(1)}% | Holders: ${token.unique_holders} | Gini: ${token.gini_coefficient.toFixed(3)} | Bots: ${(token.bot_ratio * 100).toFixed(1)}%`);
      });
    }
    
    // Check for alerts
    const alertsResult = await pool.query(`
      SELECT 
        t.symbol,
        t.mint_address,
        hs.red_flags,
        hs.yellow_flags,
        hs.positive_signals
      FROM holder_scores hs
      JOIN tokens t ON hs.token_id = t.id
      WHERE hs.score_time > NOW() - INTERVAL '5 minutes'
        AND (
          array_length(hs.red_flags, 1) > 0 OR
          array_length(hs.positive_signals, 1) > 0
        )
      LIMIT 10
    `);
    
    if (alertsResult.rows.length > 0) {
      console.log('\n🚨 RECENT ALERTS');
      console.log('─'.repeat(50));
      alertsResult.rows.forEach(alert => {
        if (alert.red_flags && alert.red_flags.length > 0) {
          console.log(`❌ ${alert.symbol}: ${alert.red_flags.join(', ')}`);
        }
        if (alert.positive_signals && alert.positive_signals.length > 0) {
          console.log(`✅ ${alert.symbol}: ${alert.positive_signals.join(', ')}`);
        }
      });
    }
    
    console.log('═'.repeat(50));
    
  } catch (error) {
    console.error('Error displaying statistics:', error);
  }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log('\n\n🛑 Shutting down holder score monitor...');
  
  if (service) {
    service.stop();
  }
  
  const pool = getDbPool();
  await pool.end();
  
  console.log('✅ Holder score monitor stopped');
  process.exit(0);
}

// Start the service
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

/**
 * Usage:
 * 1. Set environment variables:
 *    - HELIUS_API_KEY: Your Helius API key
 *    - RPC_URL: (Optional) Custom RPC endpoint
 *    - HOLDER_SCORE_INTERVAL: (Optional) Minutes between checks (default: 5)
 * 
 * 2. Run the monitor:
 *    npm run holder:monitor
 *    
 * 3. The service will:
 *    - Monitor tokens with 10-25% bonding curve progress
 *    - Fetch holder data using Helius API
 *    - Calculate distribution, quality, and activity scores
 *    - Save scores and alerts to database
 *    - Display statistics every minute
 */