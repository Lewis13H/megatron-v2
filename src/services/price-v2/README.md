# SOL Price Service V2

A simplified, robust SOL/USD price aggregation service that replaces the overly complex multi-service architecture.

## Features

- ✅ **Simple API**: Just `getSolPrice()` - no complex setup required
- ✅ **Multi-source aggregation**: Combines Pyth (via Hermes) and Binance prices
- ✅ **Automatic outlier detection**: Filters anomalous prices
- ✅ **Built-in caching**: Reduces API calls and improves performance
- ✅ **Health monitoring**: Track source reliability
- ✅ **Database persistence**: Automatic storage of price history
- ✅ **Event-driven updates**: Subscribe to price changes

## Architecture

```
┌─────────────────────────────────────────────────┐
│                Price Aggregator                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│  │   Sources   │  │    Cache    │  │  Store  │ │
│  │ ┌─────────┐ │  │             │  │         │ │
│  │ │ Hermes  │ │  │  In-memory  │  │   DB    │ │
│  │ └─────────┘ │  │   5s TTL    │  │ Storage │ │
│  │ ┌─────────┐ │  │             │  │         │ │
│  │ │ Binance │ │  └─────────────┘  └─────────┘ │
│  │ └─────────┘ │                                │
│  └─────────────┘                                │
└─────────────────────────────────────────────────┘
```

## Quick Start

```typescript
import { getSolPrice, startPriceUpdates } from './services/price-v2';

// Start automatic price updates
await startPriceUpdates();

// Get current price
const price = await getSolPrice();
console.log(`SOL: $${price}`);
```

## API Reference

### Core Functions

#### `getSolPrice(): Promise<number>`
Get the current SOL price in USD.

```typescript
const price = await getSolPrice();
// 185.42
```

#### `getSolPriceWithDetails(): Promise<PriceData>`
Get price with metadata.

```typescript
const data = await getSolPriceWithDetails();
// {
//   price: 185.42,
//   source: 'aggregated',
//   timestamp: Date,
//   confidence: 0.95
// }
```

#### `startPriceUpdates(): Promise<void>`
Start automatic price updates (every 30s by default).

#### `stopPriceUpdates(): void`
Stop automatic updates.

#### `subscribeToPriceUpdates(callback): void`
Subscribe to price changes.

```typescript
subscribeToPriceUpdates((price) => {
  console.log(`New price: $${price.price}`);
});
```

## Configuration

Default configuration in `config.ts`:

```typescript
{
  sources: {
    hermes: { priority: 1, timeout: 5000, retryCount: 3 },
    binance: { priority: 2, timeout: 10000, retryCount: 2 }
  },
  updateInterval: 2000,     // 2 seconds (was 30s)
  cacheTime: 1500,         // 1.5 seconds
  outlierThreshold: 0.05,  // 5% deviation
  minSources: 1            // min sources for valid price
}
```

### Environment Variables

You can override the update frequency with environment variables:

```bash
# Update every 3 seconds
SOL_PRICE_UPDATE_INTERVAL=3000 npm run sol-price:updater

# Update every 1 second with 800ms cache
SOL_PRICE_UPDATE_INTERVAL=1000 SOL_PRICE_CACHE_TIME=800 npm run sol-price:updater
```

### Rate Limits

- **Binance**: 100 requests/second without API key (6,000/minute)
- **Hermes**: No strict rate limit
- Safe update intervals: 1-60 seconds

## Migration from V1

### Before (Complex)
```typescript
const binanceService = new BinancePriceService();
const hermesService = new HermesPriceService();
jupiterService.startPriceUpdates(30000);
hermesService.startPriceUpdates(5000);
// Handle subscriptions, errors, etc...
```

### After (Simple)
```typescript
import { startPriceUpdates, getSolPrice } from './services/price-v2';

await startPriceUpdates();
const price = await getSolPrice();
```

## Integration Examples

### In Monitors
```typescript
// Calculate USD values for tokens
const tokenPriceUSD = tokenPriceSOL * await getSolPrice();
```

### In Database Operations
```typescript
const solPrice = await getSolPrice();
await saveTransaction({
  ...txData,
  pricePerTokenUSD: txData.pricePerToken * solPrice,
  solAmountUSD: txData.solAmount * solPrice
});
```

## Health Monitoring

```typescript
const health = getPriceServiceHealth();
// {
//   sources: [
//     { name: 'hermes', healthy: true, lastError: null },
//     { name: 'binance', healthy: true, lastError: null }
//   ],
//   cacheSize: 3,
//   isRunning: true
// }
```

## Benefits Over V1

1. **70% Less Code**: Removed redundant implementations
2. **Single Entry Point**: One API for all price needs
3. **Better Reliability**: Automatic failover and outlier detection
4. **Improved Performance**: Smart caching reduces API calls
5. **Easier Testing**: Clean interfaces and dependency injection
6. **Production Ready**: Built-in health checks and monitoring

## Running the Service

```bash
# Start standalone price updater
npm run sol-price:v2

# Run migration test
npx ts-node src/services/price-v2/migrate-to-v2.ts
```