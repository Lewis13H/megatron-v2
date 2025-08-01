import { PriceAggregator } from './price-aggregator';
import { loadConfig } from './config';
import { PriceData } from './types';

// Singleton instance
let aggregator: PriceAggregator | null = null;

export function getSolPriceAggregator(): PriceAggregator {
  if (!aggregator) {
    const config = loadConfig();
    aggregator = new PriceAggregator(config);
  }
  return aggregator;
}

export async function getSolPrice(): Promise<number> {
  const agg = getSolPriceAggregator();
  const priceData = await agg.getCurrentPrice();
  return priceData.price;
}

export async function getSolPriceWithDetails(): Promise<PriceData> {
  const agg = getSolPriceAggregator();
  return agg.getCurrentPrice();
}

export async function startPriceUpdates(): Promise<void> {
  const agg = getSolPriceAggregator();
  await agg.start();
}

export function stopPriceUpdates(): void {
  const agg = getSolPriceAggregator();
  agg.stop();
}

export function subscribeToPriceUpdates(callback: (price: PriceData) => void): void {
  const agg = getSolPriceAggregator();
  agg.on('price', callback);
}

export function unsubscribeFromPriceUpdates(callback: (price: PriceData) => void): void {
  const agg = getSolPriceAggregator();
  agg.off('price', callback);
}

export function getPriceServiceHealth(): any {
  const agg = getSolPriceAggregator();
  return agg.getHealthStatus();
}

// Export types
export type { PriceData } from './types';