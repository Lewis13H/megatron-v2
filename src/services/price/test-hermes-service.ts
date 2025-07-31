import { HermesPriceService } from './hermes-price-service';

async function testHermesService() {
    console.log('Testing Hermes price service...\n');
    
    const hermesService = new HermesPriceService();
    
    try {
        // Get current price
        const price = await hermesService.getCurrentPrice();
        
        console.log('✅ Successfully fetched SOL/USD price from Hermes:');
        console.log(`  Price: $${price.price.toFixed(4)}`);
        console.log(`  Confidence: ±$${price.confidence?.toFixed(4) || 'N/A'}`);
        console.log(`  Timestamp: ${price.timestamp.toISOString()}`);
        console.log(`  Age: ${Math.floor((Date.now() - price.timestamp.getTime()) / 1000)} seconds`);
        
        // Test periodic updates
        console.log('\n📊 Starting periodic updates (5 second intervals)...');
        hermesService.subscribeToUpdates((update) => {
            console.log(`[${new Date().toISOString()}] Price update: $${update.price.toFixed(4)}`);
        });
        
        await hermesService.startPriceUpdates(5000);
        
        // Run for 20 seconds
        await new Promise(resolve => setTimeout(resolve, 20000));
        
        console.log('\n🛑 Stopping price updates...');
        hermesService.stopPriceUpdates();
        
    } catch (error) {
        console.error('❌ Error:', error);
    }
}

testHermesService().catch(console.error);