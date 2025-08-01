#!/usr/bin/env node
import { startPriceUpdates, stopPriceUpdates, getSolPrice, subscribeToPriceUpdates } from './index';

async function migrate() {
  console.log('🔄 Migrating to SOL Price Service V2...\n');
  
  console.log('📋 Migration Steps:');
  console.log('1. Replace old imports with new simplified API');
  console.log('2. Update workers to use new service');
  console.log('3. Remove old price service files\n');
  
  console.log('🚀 Starting new price service...');
  
  try {
    // Start the new service
    await startPriceUpdates();
    
    // Test fetching price
    const price = await getSolPrice();
    console.log(`✅ Current SOL price: $${price.toFixed(4)}`);
    
    // Subscribe to updates for testing
    let updateCount = 0;
    subscribeToPriceUpdates((priceData) => {
      updateCount++;
      console.log(`📈 Price update #${updateCount}: $${priceData.price.toFixed(4)} from ${priceData.source}`);
      
      if (updateCount >= 3) {
        console.log('\n✅ Migration test successful!');
        console.log('\n📝 Next steps:');
        console.log('1. Update monitor integration to use new API:');
        console.log('   import { getSolPrice } from \'../services/price-v2\';');
        console.log('   const solPrice = await getSolPrice();');
        console.log('\n2. Update package.json script:');
        console.log('   "sol-price:updater": "npx ts-node src/services/price-v2/price-updater.ts"');
        console.log('\n3. Remove old files:');
        console.log('   - src/services/price/*.ts');
        console.log('   - src/workers/sol-price-updater.ts');
        
        stopPriceUpdates();
        process.exit(0);
      }
    });
    
    console.log('\n⏳ Waiting for price updates to verify system...');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Code examples for migration
console.log('\n📚 Migration Examples:\n');

console.log('OLD WAY:');
console.log(`
import { JupiterSolPriceService } from './services/price/jupiter-sol-price-service';
import { HermesPriceService } from './services/price/hermes-price-service';

const jupiterService = new JupiterSolPriceService();
const hermesService = new HermesPriceService();

// Complex setup and management
jupiterService.startPriceUpdates(30000);
hermesService.startPriceUpdates(5000);
`);

console.log('\nNEW WAY:');
console.log(`
import { startPriceUpdates, getSolPrice } from './services/price-v2';

// Simple API
await startPriceUpdates();
const price = await getSolPrice();
`);

console.log('\n' + '='.repeat(50) + '\n');

// Run migration test
if (require.main === module) {
  migrate();
}