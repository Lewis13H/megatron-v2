#!/usr/bin/env node
import { startPriceUpdates, stopPriceUpdates, subscribeToPriceUpdates, getPriceServiceHealth } from './index';

async function main() {
  console.log('🚀 Starting SOL Price Updater V2...\n');
  
  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    console.log('\n⏹️  Shutting down gracefully...');
    stopPriceUpdates();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n⏹️  Shutting down gracefully...');
    stopPriceUpdates();
    process.exit(0);
  });
  
  try {
    // Start price updates
    await startPriceUpdates();
    
    // Subscribe to price updates for logging
    subscribeToPriceUpdates((priceData) => {
      const timestamp = new Date().toISOString();
      const priceStr = priceData.price.toFixed(4);
      const confStr = priceData.confidence ? ` ±${(priceData.confidence * 100).toFixed(2)}%` : '';
      
      console.log(`[${timestamp}] SOL/USD: $${priceStr}${confStr} (${priceData.source})`);
    });
    
    // Periodic health check
    setInterval(() => {
      const health = getPriceServiceHealth();
      console.log('\n📊 Health Status:');
      console.log(`Running: ${health.isRunning}`);
      console.log(`Cache Size: ${health.cacheSize}`);
      console.log('Sources:');
      health.sources.forEach((s: any) => {
        const status = s.healthy ? '✅' : '❌';
        const error = s.lastError ? ` (${s.lastError})` : '';
        console.log(`  ${status} ${s.name}${error}`);
      });
      console.log('');
    }, 60000); // Every minute
    
    console.log('✅ SOL Price Updater V2 is running\n');
    console.log('Press Ctrl+C to stop\n');
    
  } catch (error) {
    console.error('❌ Failed to start price updater:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}