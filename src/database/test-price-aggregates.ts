import { priceOperations } from './price-operations';
import { pool } from './config';
import fs from 'fs';
import path from 'path';

async function testPriceAggregates() {
  console.log('🔍 Testing Price Aggregates & Continuous Views\n');

  try {
    // First ensure functions are up to date
    console.log('Updating price aggregate functions...');
    try {
      await pool.query('DROP FUNCTION IF EXISTS get_latest_price(UUID)');
      await pool.query('DROP FUNCTION IF EXISTS get_price_change(UUID, INTERVAL)');
    } catch (err) {
      // Ignore errors
    }
    const functionsPath = path.join(__dirname, '..', '..', 'migrations', '004c_create_price_functions.sql');
    const functionsSql = fs.readFileSync(functionsPath, 'utf8');
    await pool.query(functionsSql);
    console.log('✅ Functions updated\n');
    // Get some active tokens with transactions
    console.log('1. Finding active tokens with recent transactions...');
    const activeTokensQuery = `
      SELECT DISTINCT 
        t.id,
        t.mint_address,
        t.symbol,
        t.name,
        COUNT(tx.signature) as tx_count
      FROM tokens t
      JOIN transactions tx ON t.id = tx.token_id
      WHERE tx.block_time > NOW() - INTERVAL '24 hours'
      GROUP BY t.id, t.mint_address, t.symbol, t.name
      HAVING COUNT(tx.signature) > 10
      ORDER BY tx_count DESC
      LIMIT 5
    `;
    
    const result = await pool.query(activeTokensQuery);
    const activeTokens = result.rows;
    console.log(`Found ${activeTokens.length} active tokens\n`);

    if (activeTokens.length === 0) {
      console.log('❌ No active tokens found. Run monitors to capture transaction data first.');
      return;
    }

    // Test each active token
    for (const token of activeTokens) {
      console.log(`\n📊 Testing token: ${token.symbol} (${token.mint_address})`);
      console.log(`   Transaction count: ${token.tx_count}`);

      // Test 1: Get latest price
      console.log('\n   Testing getLatestPrice()...');
      const latestPrice = await priceOperations.getLatestPrice(token.id);
      if (latestPrice) {
        console.log(`   ✅ Latest price: ${latestPrice.price.toFixed(10)} SOL`);
        console.log(`      Last update: ${latestPrice.bucket.toISOString()}`);
        console.log(`      1h volume: ${latestPrice.volume_sol_1h.toFixed(4)} SOL`);
        console.log(`      1h trades: ${latestPrice.trade_count_1h}`);
      } else {
        console.log('   ❌ No price data available (continuous aggregate may be refreshing)');
      }

      // Test 2: Get price change
      console.log('\n   Testing getPriceChange()...');
      const priceChange1h = await priceOperations.getPriceChange(token.id, '1 hour');
      const priceChange24h = await priceOperations.getPriceChange(token.id, '24 hours');
      
      if (priceChange1h) {
        console.log(`   ✅ 1h price change: ${priceChange1h.price_change_percent.toFixed(2)}%`);
        console.log(`      Current: ${priceChange1h.current_price.toFixed(10)} SOL`);
        console.log(`      Previous: ${priceChange1h.previous_price.toFixed(10)} SOL`);
      }
      
      if (priceChange24h) {
        console.log(`   ✅ 24h price change: ${priceChange24h.price_change_percent.toFixed(2)}%`);
      }

      // Test 3: Get price candles
      console.log('\n   Testing getPriceCandles()...');
      const startTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      const candles = await priceOperations.getPriceCandles(token.id, startTime);
      console.log(`   ✅ Retrieved ${candles.length} candles`);
      
      if (candles.length > 0) {
        const firstCandle = candles[0];
        const lastCandle = candles[candles.length - 1];
        console.log(`      First candle: ${firstCandle.bucket.toISOString()}`);
        console.log(`      Last candle: ${lastCandle.bucket.toISOString()}`);
        
        // Calculate total volume
        const totalVolume = candles.reduce((sum, c) => sum + c.volume_sol, 0);
        const totalTrades = candles.reduce((sum, c) => sum + c.trade_count, 0);
        console.log(`      Total volume: ${totalVolume.toFixed(4)} SOL`);
        console.log(`      Total trades: ${totalTrades}`);
      }

      // Test 4: Validate price candle accuracy
      console.log('\n   Testing validatePriceCandles()...');
      const validation = await priceOperations.validatePriceCandles(token.id, '1 hour');
      console.log(`   ✅ Validation complete:`);
      console.log(`      Accuracy rate: ${validation.summary.accuracy_rate}`);
      console.log(`      Total candles: ${validation.summary.total_candles}`);
      console.log(`      Discrepancies: ${validation.summary.discrepancy_count}`);
      
      if (validation.discrepancies.length > 0) {
        console.log('\n      Sample discrepancies:');
        validation.discrepancies.slice(0, 3).forEach(d => {
          console.log(`      - ${new Date(d.minute).toISOString()}: Count ${d.raw_count} vs ${d.candle_count}`);
        });
      }

      // Test 5: Get volume statistics
      console.log('\n   Testing getVolumeStats()...');
      const volumeStats = await priceOperations.getVolumeStats(token.id);
      if (volumeStats) {
        console.log(`   ✅ Volume statistics:`);
        console.log(`      1h volume: ${volumeStats.volume_sol_1h.toFixed(4)} SOL`);
        console.log(`      24h volume: ${volumeStats.volume_sol_24h.toFixed(4)} SOL`);
        console.log(`      1h trades: ${volumeStats.trade_count_1h}`);
        console.log(`      24h trades: ${volumeStats.trade_count_24h}`);
        console.log(`      1h unique traders: ${volumeStats.unique_traders_1h}`);
        console.log(`      24h unique traders: ${volumeStats.unique_traders_24h}`);
      }
    }

    // Test 6: Get top volume tokens
    console.log('\n\n2. Testing getTopVolumeTokens()...');
    const topTokens = await priceOperations.getTopVolumeTokens(10);
    console.log(`Found ${topTokens.length} high-volume tokens:\n`);
    
    topTokens.forEach((token, idx) => {
      console.log(`   ${idx + 1}. ${token.symbol || 'Unknown'} (${token.platform})`);
      console.log(`      Volume: ${parseFloat(token.volume_sol_1h).toFixed(4)} SOL`);
      console.log(`      Trades: ${token.trade_count_1h}`);
      console.log(`      Avg Price: ${parseFloat(token.avg_price_1h).toFixed(10)} SOL`);
      console.log(`      Volatility: ${token.volatility_1h}%`);
    });

    // Test 7: Multi-token price trends
    console.log('\n\n3. Testing getMultiTokenPriceTrends()...');
    const tokenIds = activeTokens.map((t: any) => t.id);
    const priceTrends = await priceOperations.getMultiTokenPriceTrends(tokenIds);
    
    console.log(`Retrieved price trends for ${priceTrends.size} tokens:\n`);
    let idx = 0;
    for (const [tokenId, trend] of priceTrends) {
      const token = activeTokens.find((t: any) => t.id === tokenId);
      console.log(`   ${++idx}. ${token?.symbol || 'Unknown'}: ${trend.price_change_percent.toFixed(2)}% (1h)`);
    }

    // Test 8: Force refresh continuous aggregate
    console.log('\n\n4. Testing continuous aggregate refresh...');
    const refreshStart = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    await priceOperations.refreshPriceCandles(refreshStart);
    console.log('✅ Continuous aggregate refresh triggered');

    // Check continuous aggregate status
    console.log('\n\n5. Checking continuous aggregate status...');
    const caggStatusQuery = `
      SELECT 
        view_name,
        view_owner,
        materialized_only,
        finalized
      FROM timescaledb_information.continuous_aggregates
      WHERE view_name = 'price_candles_1m_cagg'
    `;
    
    const caggStatusResult = await pool.query(caggStatusQuery);
    const caggStatus = caggStatusResult.rows;
    if (caggStatus.length > 0) {
      const status = caggStatus[0];
      console.log('Continuous Aggregate Status:');
      console.log(`   View: ${status.view_name}`);
      console.log(`   Owner: ${status.view_owner}`);
      console.log(`   Materialized only: ${status.materialized_only}`);
      console.log(`   Finalized: ${status.finalized}`);
    }

    // Performance check
    console.log('\n\n6. Checking query performance...');
    const perfQuery = `
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM price_candles_1m_cagg
      WHERE token_id = $1::uuid
        AND bucket > NOW() - INTERVAL '1 hour'
      ORDER BY bucket DESC
    `;
    
    const perfResult = await pool.query(perfQuery, [activeTokens[0].id]);
    const perfData = perfResult.rows;
    const plan = perfData[0]['QUERY PLAN'][0]['Plan'];
    console.log('Query Performance:');
    console.log(`   Execution time: ${plan['Actual Total Time'].toFixed(2)}ms`);
    console.log(`   Rows returned: ${plan['Actual Rows']}`);
    
    console.log('\n✅ Price aggregate testing complete!');

  } catch (error) {
    console.error('❌ Error testing price aggregates:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  }
}

// Run setup script for price aggregates
async function setupPriceAggregates() {
  console.log('🚀 Setting up price aggregates...\n');
  
  try {
    // Step 1: Run main migration (tables, indexes, functions)
    console.log('1. Creating price candles table and functions...');
    const migrationPath = path.join(__dirname, '..', '..', 'migrations', '004_create_price_aggregates.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await pool.query(migrationSql);
    console.log('✅ Tables and functions created');
    
    // Step 2: Create continuous aggregate (must be outside transaction)
    console.log('\n2. Creating continuous aggregate...');
    const caggPath = path.join(__dirname, '..', '..', 'migrations', '004b_create_price_cagg.sql');
    const caggSql = fs.readFileSync(caggPath, 'utf8');
    
    // Execute each statement separately to avoid transaction issues
    const statements = caggSql.split(';').filter(s => s.trim());
    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await pool.query(statement);
        } catch (err: any) {
          if (err.code === '42P07') { // relation already exists
            console.log('   Continuous aggregate already exists, skipping...');
          } else {
            throw err;
          }
        }
      }
    }
    console.log('✅ Continuous aggregate created');
    
    // Step 3: Create functions that depend on continuous aggregate
    console.log('\n3. Creating helper functions...');
    const functionsPath = path.join(__dirname, '..', '..', 'migrations', '004c_create_price_functions.sql');
    const functionsSql = fs.readFileSync(functionsPath, 'utf8');
    await pool.query(functionsSql);
    console.log('✅ Helper functions created');
    
    // Step 4: Add refresh policy
    console.log('\n4. Setting up refresh policy...');
    try {
      await pool.query(`
        SELECT add_continuous_aggregate_policy('price_candles_1m_cagg',
          start_offset => INTERVAL '2 hours',
          end_offset => INTERVAL '1 minute',
          schedule_interval => INTERVAL '1 minute',
          if_not_exists => TRUE)
      `);
      console.log('✅ Refresh policy configured');
    } catch (err: any) {
      if (err.message.includes('already exists')) {
        console.log('   Refresh policy already exists');
      } else {
        throw err;
      }
    }
    
    console.log('\n✅ Price aggregates setup complete!');
    
    // Wait a moment for continuous aggregate to initialize
    console.log('\nWaiting for continuous aggregate to initialize...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Run tests
    await testPriceAggregates();
  } catch (error) {
    console.error('❌ Error setting up price aggregates:', error);
  }
}

// Export for use in npm scripts
export { testPriceAggregates, setupPriceAggregates };

// Run if called directly
if (require.main === module) {
  const command = process.argv[2];
  
  if (command === 'setup') {
    setupPriceAggregates().then(() => process.exit(0)).catch(() => process.exit(1));
  } else if (command === 'test') {
    testPriceAggregates().then(() => process.exit(0)).catch(() => process.exit(1));
  } else {
    console.log('Usage: npm run db:setup:prices or npm run db:test:prices');
    process.exit(1);
  }
}