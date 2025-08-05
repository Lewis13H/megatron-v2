import dotenv from 'dotenv';
import { HolderScoreAnalyzer } from '../scoring/holder-score-implementation';
import { getHeliusService } from '../services/helius-api-service';
import { getLatestHolderScore } from '../database/monitor-integration';
import { getDbPool } from '../database/connection';

dotenv.config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const RPC_URL = process.env.RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

/**
 * Test holder scoring for a specific token
 */
async function testHolderScore(tokenMint: string, bondingCurveProgress?: number) {
  console.log(`\n🧪 Testing holder score for token: ${tokenMint}`);
  console.log('═'.repeat(60));

  try {
    // If bonding curve progress not provided, fetch from database
    if (bondingCurveProgress === undefined) {
      const pool = getDbPool();
      const result = await pool.query(`
        SELECT p.bonding_curve_progress, t.symbol, t.name
        FROM pools p
        JOIN tokens t ON p.token_id = t.id
        WHERE t.mint_address = $1
        LIMIT 1
      `, [tokenMint]);

      if (result.rows.length === 0) {
        console.error('❌ Token not found in database');
        return;
      }

      bondingCurveProgress = parseFloat(result.rows[0].bonding_curve_progress);
      console.log(`Token: ${result.rows[0].symbol} (${result.rows[0].name})`);
    }

    console.log(`Bonding Curve Progress: ${bondingCurveProgress.toFixed(2)}%`);

    // Check if eligible for holder scoring
    if (bondingCurveProgress < 10 || bondingCurveProgress > 25) {
      console.log('⚠️  Token not eligible for holder scoring (requires 10-25% progress)');
      return;
    }

    // Initialize services
    const holderAnalyzer = new HolderScoreAnalyzer(HELIUS_API_KEY, RPC_URL);
    const heliusService = getHeliusService(HELIUS_API_KEY);

    // 1. Fetch holder data
    console.log('\n📊 Fetching holder data...');
    const holders = await heliusService.getAllTokenHolders(tokenMint);
    console.log(`Found ${holders.length} unique holders`);

    if (holders.length < 5) {
      console.log('⚠️  Insufficient holders for analysis (minimum 5 required)');
      return;
    }

    // 2. Calculate distribution metrics
    const metrics = heliusService.calculateDistributionMetrics(holders);
    console.log('\n📈 Distribution Metrics:');
    console.log(`  • Top holder: ${metrics.topHolderPercentage.toFixed(2)}%`);
    console.log(`  • Top 5 holders: ${metrics.top5Percentage.toFixed(2)}%`);
    console.log(`  • Top 10 holders: ${metrics.top10Percentage.toFixed(2)}%`);
    console.log(`  • Gini coefficient: ${metrics.giniCoefficient.toFixed(3)}`);
    console.log(`  • HHI index: ${metrics.hhiIndex.toFixed(2)}`);
    console.log(`  • Whales (>5%): ${metrics.whalesCount}`);
    console.log(`  • Large holders (1-5%): ${metrics.largeHoldersCount}`);
    console.log(`  • Medium holders (0.1-1%): ${metrics.mediumHoldersCount}`);
    console.log(`  • Small holders (<0.1%): ${metrics.smallHoldersCount}`);

    // 3. Analyze top holders
    console.log('\n👥 Top 10 Holders:');
    holders.slice(0, 10).forEach((holder, index) => {
      console.log(`  ${index + 1}. ${holder.owner.substring(0, 8)}... - ${holder.percentage?.toFixed(2)}% (${holder.uiAmount.toFixed(2)} tokens)`);
    });

    // 4. Calculate holder score
    console.log('\n🎯 Calculating holder score...');
    const score = await holderAnalyzer.analyzeToken(tokenMint, bondingCurveProgress);

    if (!score) {
      console.log('❌ Failed to calculate holder score');
      return;
    }

    // 5. Display score breakdown
    console.log('\n📊 HOLDER SCORE BREAKDOWN');
    console.log('─'.repeat(40));
    console.log(`Distribution Score: ${score.distribution}/111`);
    console.log(`Quality Score: ${score.quality}/111`);
    console.log(`Activity Score: ${score.activity}/111`);
    console.log('─'.repeat(40));
    console.log(`TOTAL SCORE: ${score.total}/333`);
    console.log('─'.repeat(40));

    // 6. Display detailed metrics
    console.log('\n📋 Detailed Metrics:');
    console.log(`  • Unique holders: ${score.details.uniqueHolders}`);
    console.log(`  • Average wallet age: ${score.details.avgWalletAge.toFixed(1)} days`);
    console.log(`  • Bot ratio: ${(score.details.botRatio * 100).toFixed(1)}%`);
    console.log(`  • Organic growth score: ${(score.details.organicGrowthScore * 100).toFixed(1)}%`);

    // 7. Check for red flags
    console.log('\n🚨 Risk Analysis:');
    const redFlags = [];
    const yellowFlags = [];
    const positiveSignals = [];

    if (metrics.topHolderPercentage > 15) {
      redFlags.push('Single wallet owns >15%');
    } else if (metrics.topHolderPercentage > 10) {
      yellowFlags.push('Single wallet owns >10%');
    }

    if (score.details.botRatio > 0.3) {
      redFlags.push(`High bot ratio: ${(score.details.botRatio * 100).toFixed(1)}%`);
    } else if (score.details.botRatio > 0.2) {
      yellowFlags.push(`Moderate bot ratio: ${(score.details.botRatio * 100).toFixed(1)}%`);
    }

    if (score.details.giniCoefficient > 0.8) {
      redFlags.push(`Poor distribution (Gini: ${score.details.giniCoefficient.toFixed(3)})`);
    }

    if (score.total > 250) {
      positiveSignals.push('Excellent holder base quality');
    } else if (score.total > 200) {
      positiveSignals.push('Good holder base quality');
    }

    if (score.details.avgWalletAge > 60) {
      positiveSignals.push('Mature wallet holders');
    }

    if (redFlags.length > 0) {
      console.log('❌ Red Flags:');
      redFlags.forEach(flag => console.log(`   - ${flag}`));
    }

    if (yellowFlags.length > 0) {
      console.log('⚠️  Yellow Flags:');
      yellowFlags.forEach(flag => console.log(`   - ${flag}`));
    }

    if (positiveSignals.length > 0) {
      console.log('✅ Positive Signals:');
      positiveSignals.forEach(signal => console.log(`   - ${signal}`));
    }

    // 8. Get historical scores
    const latestScore = await getLatestHolderScore(tokenMint);
    if (latestScore) {
      console.log('\n📈 Score History:');
      console.log(`Latest score: ${latestScore.total_score}/333 (${new Date(latestScore.score_time).toLocaleString()})`);
    }

    console.log('\n✅ Holder score analysis complete!');

  } catch (error) {
    console.error('❌ Error testing holder score:', error);
  }
}

/**
 * Test multiple tokens
 */
async function testMultipleTokens() {
  const pool = getDbPool();
  
  try {
    // Get eligible tokens
    const result = await pool.query(`
      SELECT 
        t.mint_address,
        t.symbol,
        p.bonding_curve_progress
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE p.platform = 'pumpfun'
        AND p.bonding_curve_progress >= 10
        AND p.bonding_curve_progress <= 25
        AND p.status = 'active'
      ORDER BY p.bonding_curve_progress DESC
      LIMIT 5
    `);

    console.log(`\n🔍 Testing ${result.rows.length} eligible tokens...`);

    for (const token of result.rows) {
      await testHolderScore(token.mint_address, parseFloat(token.bonding_curve_progress));
      await new Promise(resolve => setTimeout(resolve, 2000)); // Rate limiting
    }

  } catch (error) {
    console.error('Error testing multiple tokens:', error);
  }
}

/**
 * Main test function
 */
async function main() {
  if (!HELIUS_API_KEY) {
    console.error('❌ HELIUS_API_KEY environment variable is required');
    process.exit(1);
  }

  console.log('🚀 Holder Score Testing Tool');
  console.log('═'.repeat(60));

  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage:');
    console.log('  npm run test:holder <token_mint>');
    console.log('  npm run test:holder --multiple');
    console.log('');
    console.log('Example:');
    console.log('  npm run test:holder EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    process.exit(1);
  }

  if (args[0] === '--multiple') {
    await testMultipleTokens();
  } else {
    await testHolderScore(args[0]);
  }

  const pool = getDbPool();
  await pool.end();
  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});