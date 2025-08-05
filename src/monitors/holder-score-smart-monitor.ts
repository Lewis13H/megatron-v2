import dotenv from 'dotenv';
import { getDbPool } from '../database/connection';
import { HolderScoreAnalyzer } from '../scoring/holder-score-implementation';
import { getHeliusService } from '../services/helius-api-service';

dotenv.config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const RPC_URL = process.env.RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

interface TokenProgress {
  id: string;
  mintAddress: string;
  symbol: string;
  currentProgress: number;
  lastAnalyzedProgress: number;
  lastAnalyzedTime: Date | null;
  createdAt: Date;
  transactionCount: number;
}

// Progress milestones that trigger immediate analysis
const PROGRESS_MILESTONES = [10, 15, 25, 50, 75, 90, 95, 100];

// Dynamic intervals based on progress
const getCheckInterval = (progress: number): number => {
  if (progress < 25) return 15; // 15 minutes for early stage
  if (progress < 50) return 30; // 30 minutes for mid stage
  if (progress < 75) return 45; // 45 minutes for late stage
  if (progress < 95) return 15; // 15 minutes for critical stage
  return 5; // 5 minutes for near graduation
};

async function main() {
  console.log('🎯 Starting Smart Holder Score Monitor');
  console.log('📊 Progress milestones:', PROGRESS_MILESTONES.join('%, ') + '%');
  console.log('⚡ Check interval: 30 seconds\n');

  if (!HELIUS_API_KEY) {
    console.error('❌ HELIUS_API_KEY environment variable is required');
    process.exit(1);
  }

  const pool = getDbPool();
  const analyzer = new HolderScoreAnalyzer(HELIUS_API_KEY, RPC_URL);

  // Test database connection first
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✅ Database connection established\n');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    console.log('\nTip: Try running "npx ts-node src/utils/close-db-connections.ts" to close stale connections');
    process.exit(1);
  }

  // Main monitoring loop
  setInterval(async () => {
    try {
      await checkTokens(pool, analyzer);
    } catch (error) {
      console.error('Error in monitoring loop:', error);
    }
  }, 30 * 1000); // Check every 30 seconds

  // Initial check
  await checkTokens(pool, analyzer);
}

async function checkTokens(pool: any, analyzer: HolderScoreAnalyzer) {
  let client;
  try {
    // Get a client from the pool
    client = await pool.connect();
    
    // Get tokens with their progress and last analysis info
    const query = `
      SELECT 
        t.id,
        t.mint_address,
        t.symbol,
        t.created_at,
        p.bonding_curve_progress::numeric as current_progress,
        (
          SELECT hs.bonding_curve_progress::numeric 
          FROM holder_scores hs 
          WHERE hs.token_id = t.id 
          ORDER BY hs.score_time DESC 
          LIMIT 1
        ) as last_analyzed_progress,
        (
          SELECT hs.score_time 
          FROM holder_scores hs 
          WHERE hs.token_id = t.id 
          ORDER BY hs.score_time DESC 
          LIMIT 1
        ) as last_analyzed_time,
        (SELECT COUNT(*) FROM transactions WHERE token_id = t.id) as transaction_count
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE p.platform = 'pumpfun'
        AND p.status = 'active'
        AND p.bonding_curve_progress IS NOT NULL
        AND p.bonding_curve_progress >= 10
        AND p.bonding_curve_progress < 100
        AND t.created_at < NOW() - INTERVAL '30 minutes'
        AND (
          -- Never analyzed
          NOT EXISTS (SELECT 1 FROM holder_scores WHERE token_id = t.id)
          -- Or hasn't been analyzed recently
          OR NOT EXISTS (
            SELECT 1 FROM holder_scores hs 
            WHERE hs.token_id = t.id 
              AND hs.score_time > NOW() - CASE
                WHEN p.bonding_curve_progress < 25 THEN INTERVAL '15 minutes'
                WHEN p.bonding_curve_progress < 50 THEN INTERVAL '30 minutes'
                WHEN p.bonding_curve_progress < 75 THEN INTERVAL '45 minutes'
                WHEN p.bonding_curve_progress < 95 THEN INTERVAL '15 minutes'
                ELSE INTERVAL '5 minutes'
              END
          )
        )
      ORDER BY 
        -- Prioritize tokens near milestones
        CASE 
          WHEN p.bonding_curve_progress >= 90 THEN 1
          WHEN p.bonding_curve_progress >= 75 THEN 2
          WHEN NOT EXISTS (SELECT 1 FROM holder_scores WHERE token_id = t.id) THEN 3
          ELSE 4
        END,
        p.bonding_curve_progress DESC
      LIMIT 10
    `;

    const result = await client.query(query);
    
    if (result.rows.length === 0) {
      return;
    }

    console.log(`\n🔍 Found ${result.rows.length} tokens requiring analysis`);

    for (const row of result.rows) {
      // Map database columns to interface
      const token: TokenProgress = {
        id: row.id,
        mintAddress: row.mint_address,
        symbol: row.symbol,
        currentProgress: parseFloat(row.current_progress),
        lastAnalyzedProgress: row.last_analyzed_progress ? parseFloat(row.last_analyzed_progress) : 0,
        lastAnalyzedTime: row.last_analyzed_time,
        createdAt: row.created_at,
        transactionCount: parseInt(row.transaction_count) || 0
      };
      await analyzeToken(token, analyzer);
    }

  } catch (error) {
    console.error('Error checking tokens:', error);
  } finally {
    // Always release the client back to the pool
    if (client) {
      client.release();
    }
  }
}

async function analyzeToken(token: TokenProgress, analyzer: HolderScoreAnalyzer) {
  // Ensure numbers are parsed correctly
  const currentProgress = parseFloat(token.currentProgress as any) || 0;
  const lastProgress = parseFloat(token.lastAnalyzedProgress as any) || 0;
  const progressChange = currentProgress - lastProgress;
  const timeSinceLastAnalysis = token.lastAnalyzedTime 
    ? (Date.now() - new Date(token.lastAnalyzedTime).getTime()) / (1000 * 60)
    : null;

  // Determine trigger reason
  let triggerReason = 'scheduled';
  
  if (!token.lastAnalyzedTime) {
    triggerReason = 'initial';
  } else {
    // Check for milestone crossing
    for (const milestone of PROGRESS_MILESTONES) {
      if (lastProgress < milestone && currentProgress >= milestone) {
        triggerReason = `milestone ${milestone}%`;
        break;
      }
    }
    
    // Check for rapid progress
    if (triggerReason === 'scheduled' && timeSinceLastAnalysis) {
      if (timeSinceLastAnalysis < 15 && progressChange > 5) {
        triggerReason = `rapid +${progressChange.toFixed(1)}% in ${timeSinceLastAnalysis.toFixed(0)}min`;
      } else if (timeSinceLastAnalysis < 60 && progressChange > 10) {
        triggerReason = `fast +${progressChange.toFixed(1)}% in ${timeSinceLastAnalysis.toFixed(0)}min`;
      }
    }
  }

  console.log(`\n📊 ${token.symbol} - ${currentProgress.toFixed(1)}% (${triggerReason})`);
  if (token.mintAddress) {
    console.log(`   ${token.mintAddress.substring(0, 10)}...`);
  }
  
  if (lastProgress > 0) {
    console.log(`   Last: ${lastProgress.toFixed(1)}% | Change: +${progressChange.toFixed(1)}%`);
  }

  try {
    const score = await analyzer.analyzeToken(
      token.mintAddress,
      currentProgress,
      undefined,
      token.createdAt
    );

    if (score) {
      console.log(`   ✅ Score: ${score.total}/333`);
      
      // Show key metrics
      if (score.details.top10Concentration > 50) {
        console.log(`   ⚠️  Top 10: ${score.details.top10Concentration.toFixed(1)}%`);
      }
      if (score.details.botRatio > 0.3) {
        console.log(`   ⚠️  Bots: ${(score.details.botRatio * 100).toFixed(1)}%`);
      }
    }
  } catch (error) {
    console.error(`   ❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Display statistics
async function displayStats() {
  const pool = getDbPool();
  let client;
  
  try {
    client = await pool.connect();
    const statsQuery = `
      SELECT 
        COUNT(DISTINCT token_id) as tokens_analyzed,
        COUNT(*) as total_scores,
        AVG(total_score) as avg_score,
        MAX(total_score) as max_score,
        MIN(total_score) as min_score
      FROM holder_scores
      WHERE score_time > NOW() - INTERVAL '24 hours'
    `;
    
    const result = await client.query(statsQuery);
    const stats = result.rows[0];
    
    console.log('\n📈 24-Hour Statistics:');
    console.log(`   Tokens analyzed: ${stats.tokens_analyzed}`);
    console.log(`   Total scores: ${stats.total_scores}`);
    console.log(`   Average score: ${parseFloat(stats.avg_score || 0).toFixed(0)}/333`);
    console.log(`   Best score: ${stats.max_score || 0}/333`);
    console.log(`   Worst score: ${stats.min_score || 0}/333`);
    
  } catch (error) {
    console.error('Error fetching statistics:', error);
  } finally {
    if (client) {
      client.release();
    }
  }
}

// Display stats every 5 minutes
setInterval(displayStats, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down holder score monitor...');
  process.exit(0);
});

// Start the service
main().catch(console.error);