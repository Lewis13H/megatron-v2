import { MockSolPriceService } from './mock-sol-price-service';
import { getDbPool } from '../../database/connection';

async function testMockPriceService() {
    console.log('Testing Mock SOL/USD price service...\n');
    
    const pool = getDbPool();
    const mockService = new MockSolPriceService();
    
    try {
        // Test single price fetch
        console.log('1. Testing single price fetch:');
        const price = await mockService.getCurrentPrice();
        console.log(`✓ Mock SOL/USD price: $${price.price.toFixed(4)}`);
        console.log(`  Confidence: ±$${price.confidence?.toFixed(4)}`);
        console.log(`  Timestamp: ${price.timestamp.toISOString()}`);
        
        // Generate some test data
        console.log('\n2. Generating test price data (10 prices):');
        for (let i = 0; i < 10; i++) {
            const testPrice = await mockService.getCurrentPrice();
            console.log(`  Price ${i + 1}: $${testPrice.price.toFixed(4)}`);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Check database
        console.log('\n3. Checking database entries:');
        const dbCheck = await pool.query(`
            SELECT COUNT(*) as count,
                   MIN(price_usd) as min_price,
                   MAX(price_usd) as max_price,
                   AVG(price_usd) as avg_price
            FROM sol_usd_prices
            WHERE source = 'mock'
            AND price_time > NOW() - INTERVAL '1 minute'
        `);
        
        const stats = dbCheck.rows[0];
        console.log(`✓ Database entries created: ${stats.count}`);
        console.log(`  Price range: $${parseFloat(stats.min_price).toFixed(4)} - $${parseFloat(stats.max_price).toFixed(4)}`);
        console.log(`  Average price: $${parseFloat(stats.avg_price).toFixed(4)}`);
        
        // Test USD calculation function
        console.log('\n4. Testing get_sol_usd_price function:');
        const funcTest = await pool.query(`SELECT get_sol_usd_price(NOW(), 'mock') as price`);
        console.log(`✓ Function result: $${parseFloat(funcTest.rows[0].price).toFixed(4)}`);
        
        // Test real-time updates
        console.log('\n5. Testing real-time updates (5 seconds):');
        let updateCount = 0;
        
        mockService.subscribeToUpdates((price) => {
            updateCount++;
            console.log(`  Update ${updateCount}: $${price.price.toFixed(4)}`);
        });
        
        mockService.startMockUpdates(1000); // Every second
        
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        mockService.stopMockUpdates();
        console.log(`✓ Received ${updateCount} updates`);
        
        // Final summary
        console.log('\n6. Final database summary:');
        const finalStats = await pool.query(`
            SELECT source, COUNT(*) as total_entries,
                   MIN(price_usd) as min_price,
                   MAX(price_usd) as max_price,
                   STDDEV(price_usd) as price_stddev
            FROM sol_usd_prices
            WHERE price_time > NOW() - INTERVAL '10 minutes'
            GROUP BY source
        `);
        
        finalStats.rows.forEach((row: any) => {
            console.log(`\n  ${row.source}:`);
            console.log(`    Total entries: ${row.total_entries}`);
            console.log(`    Price range: $${parseFloat(row.min_price).toFixed(4)} - $${parseFloat(row.max_price).toFixed(4)}`);
            console.log(`    Std deviation: $${parseFloat(row.price_stddev || 0).toFixed(4)}`);
        });
        
        console.log('\n✅ Mock price service test completed successfully!');
        
    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        await pool.end();
    }
}

// Run test
testMockPriceService().catch(console.error);