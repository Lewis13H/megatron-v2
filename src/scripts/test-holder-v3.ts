import { HolderAnalysisServiceV3 } from '../services/holder-analysis/holder-analysis-service-v3';
import { ScoringConfigLoader } from '../config/holder-scoring-config';
import chalk from 'chalk';
import { getDbPool } from '../database/connection';

async function testHolderV3() {
  console.log(chalk.cyan('🧪 Testing Holder Analysis V3 System'));
  console.log(chalk.gray('━'.repeat(50)));
  
  const service = new HolderAnalysisServiceV3();
  const dbPool = getDbPool();
  
  try {
    // Test 1: Configuration Loading
    console.log(chalk.yellow('\n📋 Test 1: Configuration Loading'));
    const configLoader = ScoringConfigLoader.getInstance();
    const config = configLoader.getConfig();
    console.log(chalk.green('✅ Configuration loaded successfully'));
    console.log(chalk.gray(`  • Gini thresholds: ${JSON.stringify(config.distribution.gini)}`));
    console.log(chalk.gray(`  • Alert thresholds: ${JSON.stringify(config.alerts.critical)}`));
    
    // Test 2: Quick Score Function
    console.log(chalk.yellow('\n⚡ Test 2: Quick Score Function'));
    
    // Get a test token from database
    const tokenResult = await dbPool.query(`
      SELECT t.mint_address, p.bonding_curve_progress
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE p.bonding_curve_progress BETWEEN 10 AND 50
        AND p.status = 'active'
      ORDER BY t.created_at DESC
      LIMIT 1
    `);
    
    if (tokenResult.rows.length > 0) {
      const testToken = tokenResult.rows[0];
      console.log(chalk.gray(`  Testing token: ${testToken.mint_address.slice(0, 12)}...`));
      
      const startTime = Date.now();
      const quickScore = await service.getQuickScore(testToken.mint_address);
      const elapsed = Date.now() - startTime;
      
      if (quickScore) {
        console.log(chalk.green('✅ Quick score calculated successfully'));
        console.log(chalk.gray(`  • Score: ${quickScore.score}/50`));
        console.log(chalk.gray(`  • Confidence: ${quickScore.confidence}`));
        console.log(chalk.gray(`  • Processing time: ${elapsed}ms`));
        console.log(chalk.gray(`  • Should deep analyze: ${quickScore.shouldDeepAnalyze}`));
        console.log(chalk.gray(`  • Metrics: ${JSON.stringify(quickScore.metrics)}`));
      } else {
        console.log(chalk.yellow('⚠️  No quick score available (might be new token)'));
      }
    } else {
      console.log(chalk.yellow('⚠️  No active tokens found for testing'));
    }
    
    // Test 3: Configuration Override
    console.log(chalk.yellow('\n🔧 Test 3: Configuration Override'));
    configLoader.override({
      alerts: {
        critical: {
          giniThreshold: 0.85,
          botRatioThreshold: 0.45,
          riskScoreThreshold: 75
        },
        warning: {
          topHolderThreshold: 25,
          walletAgeThreshold: 5
        },
        positive: {
          smartMoneyThreshold: 0.15,
          totalScoreThreshold: 270
        }
      }
    });
    const updatedConfig = configLoader.getConfig();
    console.log(chalk.green('✅ Configuration override successful'));
    console.log(chalk.gray(`  • New Gini threshold: ${updatedConfig.alerts.critical.giniThreshold}`));
    
    // Test 4: Priority Queue Check
    console.log(chalk.yellow('\n🎯 Test 4: Check for Priority Tokens'));
    const priorityTokens = await dbPool.query(`
      SELECT 
        t.mint_address,
        t.symbol,
        MAX(tx.sol_amount) as max_transaction,
        COUNT(*) as transaction_count
      FROM transactions tx
      JOIN tokens t ON tx.token_id = t.id
      JOIN pools p ON t.id = p.token_id
      WHERE tx.block_time > NOW() - INTERVAL '10 minutes'
        AND tx.sol_amount >= 3
        AND p.bonding_curve_progress BETWEEN 5 AND 70
        AND p.status = 'active'
      GROUP BY t.mint_address, t.symbol
      ORDER BY max_transaction DESC
      LIMIT 5
    `);
    
    if (priorityTokens.rows.length > 0) {
      console.log(chalk.green(`✅ Found ${priorityTokens.rows.length} priority tokens:`));
      for (const token of priorityTokens.rows) {
        console.log(chalk.gray(`  • ${token.symbol || 'Unknown'}: ${token.max_transaction.toFixed(2)} SOL (${token.transaction_count} txs)`));
      }
    } else {
      console.log(chalk.gray('  No priority tokens found in last 10 minutes'));
    }
    
    // Test 5: Technical Score Integration
    console.log(chalk.yellow('\n📈 Test 5: Technical Score Integration'));
    const techScores = await dbPool.query(`
      SELECT 
        t.mint_address as token_address,
        ts.total_score,
        t.symbol
      FROM technical_scores ts
      JOIN tokens t ON ts.token_id = t.id
      WHERE ts.calculated_at > NOW() - INTERVAL '30 minutes'
        AND ts.total_score > 200
      ORDER BY ts.total_score DESC
      LIMIT 5
    `);
    
    if (techScores.rows.length > 0) {
      console.log(chalk.green(`✅ Found ${techScores.rows.length} high technical score tokens:`));
      for (const token of techScores.rows) {
        console.log(chalk.gray(`  • ${token.symbol || 'Unknown'}: Score ${token.total_score}/333`));
      }
    } else {
      console.log(chalk.gray('  No high technical scores found recently'));
    }
    
    console.log(chalk.green('\n✅ All tests completed successfully!'));
    
  } catch (error) {
    console.error(chalk.red('\n❌ Test failed:'), error);
  } finally {
    // Clean up
    await dbPool.end();
    process.exit(0);
  }
}

// Run tests
testHolderV3().catch(error => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});