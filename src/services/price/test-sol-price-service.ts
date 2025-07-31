import { JupiterSolPriceService } from './jupiter-sol-price-service';
import { PythSolPriceService } from './pyth-sol-price-service';
import { getDbPool } from '../../database/connection';

async function testSolPriceServices() {
    console.log('Testing SOL/USD price services...\n');
    
    const pool = getDbPool();
    
    // Test Jupiter service
    console.log('1. Testing Jupiter Price Service:');
    console.log('================================');
    const jupiterService = new JupiterSolPriceService();
    
    try {
        const jupiterPrice = await jupiterService.getCurrentPrice();
        console.log('✓ Jupiter SOL/USD price:', `$${jupiterPrice.price.toFixed(4)}`);
        console.log('  Source:', jupiterPrice.source);
        console.log('  Timestamp:', jupiterPrice.timestamp.toISOString());
        
        // Test historical fetch
        const historicalPrice = await jupiterService.getHistoricalPrice(new Date());
        if (historicalPrice) {
            console.log('✓ Historical price from DB:', `$${historicalPrice.price.toFixed(4)}`);
        }
    } catch (error) {
        console.error('✗ Jupiter service error:', error);
    }
    
    // Test Pyth service
    console.log('\n2. Testing Pyth Network Price Service:');
    console.log('=====================================');
    const pythService = new PythSolPriceService();
    
    try {
        const pythPrice = await pythService.getCurrentPrice();
        console.log('✓ Pyth SOL/USD price:', `$${pythPrice.price.toFixed(4)}`);
        console.log('  Source:', pythPrice.source);
        console.log('  Confidence:', pythPrice.confidence ? `±$${pythPrice.confidence.toFixed(4)}` : 'N/A');
        console.log('  Timestamp:', pythPrice.timestamp.toISOString());
    } catch (error) {
        console.error('✗ Pyth service error:', error);
    }
    
    // Check database entries
    console.log('\n3. Checking Database Entries:');
    console.log('============================');
    
    try {
        const recentPrices = await pool.query(`
            SELECT source, COUNT(*) as count, 
                   MIN(price_usd) as min_price, 
                   MAX(price_usd) as max_price,
                   AVG(price_usd) as avg_price,
                   MAX(price_time) as latest_time
            FROM sol_usd_prices
            WHERE price_time > NOW() - INTERVAL '1 hour'
            GROUP BY source
            ORDER BY source
        `);
        
        if (recentPrices.rows.length > 0) {
            console.log('Recent price statistics (last hour):');
            recentPrices.rows.forEach((row: any) => {
                console.log(`\n  ${row.source}:`);
                console.log(`    Count: ${row.count}`);
                console.log(`    Min: $${parseFloat(row.min_price).toFixed(4)}`);
                console.log(`    Max: $${parseFloat(row.max_price).toFixed(4)}`);
                console.log(`    Avg: $${parseFloat(row.avg_price).toFixed(4)}`);
                console.log(`    Latest: ${row.latest_time.toISOString()}`);
            });
        } else {
            console.log('No price data found in the last hour');
        }
        
        // Check health view
        const health = await pool.query('SELECT * FROM sol_usd_price_health');
        
        if (health.rows.length > 0) {
            console.log('\nPrice Feed Health:');
            health.rows.forEach((row: any) => {
                console.log(`\n  ${row.source}:`);
                console.log(`    Total records (24h): ${row.total_records}`);
                console.log(`    Last update: ${row.last_update_age || 'N/A'}`);
                console.log(`    Avg price (24h): $${parseFloat(row.avg_price_24h || 0).toFixed(4)}`);
                console.log(`    Price range: $${parseFloat(row.min_price_24h || 0).toFixed(4)} - $${parseFloat(row.max_price_24h || 0).toFixed(4)}`);
            });
        }
        
    } catch (error) {
        console.error('✗ Database query error:', error);
    }
    
    // Test subscription (for 10 seconds)
    console.log('\n4. Testing Real-time Subscriptions:');
    console.log('==================================');
    console.log('Subscribing to price updates for 10 seconds...\n');
    
    let pythUpdateCount = 0;
    let jupiterUpdateCount = 0;
    
    pythService.subscribeToUpdates((price) => {
        pythUpdateCount++;
        console.log(`[Pyth Update ${pythUpdateCount}] $${price.price.toFixed(4)} at ${price.timestamp.toISOString()}`);
    });
    
    jupiterService.subscribeToUpdates((price) => {
        jupiterUpdateCount++;
        console.log(`[Jupiter Update ${jupiterUpdateCount}] $${price.price.toFixed(4)} at ${price.timestamp.toISOString()}`);
    });
    
    // Subscribe Pyth to real-time updates
    try {
        await pythService.subscribeToPriceUpdates();
        console.log('✓ Subscribed to Pyth real-time updates');
    } catch (error) {
        console.error('✗ Failed to subscribe to Pyth updates:', error);
    }
    
    // Start Jupiter periodic updates
    jupiterService.startPriceUpdates(5000); // Every 5 seconds for testing
    console.log('✓ Started Jupiter periodic updates (5s interval)');
    
    // Wait for 10 seconds
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Cleanup
    console.log('\n5. Cleaning up:');
    console.log('==============');
    
    await pythService.cleanup();
    jupiterService.stopPriceUpdates();
    console.log('✓ Stopped all price subscriptions');
    
    // Final summary
    console.log('\nTest Summary:');
    console.log('============');
    console.log(`Pyth updates received: ${pythUpdateCount}`);
    console.log(`Jupiter updates received: ${jupiterUpdateCount}`);
    
    await pool.end();
    console.log('\n✅ All tests completed!');
}

// Run tests
testSolPriceServices().catch(console.error);