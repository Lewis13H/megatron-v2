import { PriceSource, PriceData, PriceAggregatorConfig } from './types';
import { PriceCache } from './price-cache';
import { PriceStore } from './price-store';
import { HermesPriceSource } from './sources/hermes-source';
import { BinancePriceSource } from './sources/binance-source';
import { EventEmitter } from 'events';

export class PriceAggregator extends EventEmitter {
  private sources: Map<string, PriceSource> = new Map();
  private cache: PriceCache;
  private store: PriceStore;
  private updateInterval?: NodeJS.Timeout;
  private isRunning = false;
  
  constructor(
    private readonly config: PriceAggregatorConfig,
    store?: PriceStore
  ) {
    super();
    this.cache = new PriceCache(config.cacheTime);
    this.store = store || new PriceStore();
    this.initializeSources();
  }
  
  private initializeSources(): void {
    for (const [name, sourceConfig] of this.config.sources) {
      let source: PriceSource;
      
      switch (name) {
        case 'hermes':
          source = new HermesPriceSource(sourceConfig);
          break;
        case 'binance':
          source = new BinancePriceSource(sourceConfig);
          break;
        default:
          console.warn(`Unknown price source: ${name}`);
          continue;
      }
      
      this.sources.set(name, source);
    }
  }
  
  async getCurrentPrice(): Promise<PriceData> {
    // Check cache first
    const cachedPrice = this.cache.get('aggregated');
    if (cachedPrice) {
      return cachedPrice;
    }
    
    // Fetch from all sources
    const prices = await this.fetchFromAllSources();
    
    if (prices.length === 0) {
      // Try to get from database as last resort
      const dbPrice = await this.store.getLatestPrice();
      if (dbPrice) {
        return dbPrice;
      }
      throw new Error('No price data available from any source');
    }
    
    // Aggregate prices
    const aggregatedPrice = this.aggregatePrices(prices);
    
    // Cache the result
    this.cache.set('aggregated', aggregatedPrice);
    
    // Save all prices to database
    await this.store.savePrices(prices);
    
    // Emit price update event
    this.emit('price', aggregatedPrice);
    
    return aggregatedPrice;
  }
  
  private async fetchFromAllSources(): Promise<PriceData[]> {
    const promises = Array.from(this.sources.entries()).map(async ([name, source]) => {
      try {
        const price = await source.fetchPrice();
        this.cache.set(name, price);
        return price;
      } catch (error) {
        console.error(`Failed to fetch price from ${name}:`, error);
        return null;
      }
    });
    
    const results = await Promise.allSettled(promises);
    
    return results
      .filter((r): r is PromiseFulfilledResult<PriceData | null> => 
        r.status === 'fulfilled' && r.value !== null
      )
      .map(r => r.value!);
  }
  
  private aggregatePrices(prices: PriceData[]): PriceData {
    if (prices.length === 0) {
      throw new Error('No prices to aggregate');
    }
    
    if (prices.length === 1) {
      return prices[0];
    }
    
    // Sort prices
    const sortedPrices = prices.map(p => p.price).sort((a, b) => a - b);
    
    // Calculate median
    const mid = Math.floor(sortedPrices.length / 2);
    const median = sortedPrices.length % 2 === 0
      ? (sortedPrices[mid - 1] + sortedPrices[mid]) / 2
      : sortedPrices[mid];
    
    // Filter outliers
    const filteredPrices = prices.filter(p => {
      const deviation = Math.abs(p.price - median) / median;
      return deviation <= this.config.outlierThreshold;
    });
    
    // If too many outliers, use all prices
    if (filteredPrices.length < this.config.minSources) {
      console.warn('Too many outliers detected, using all prices');
      filteredPrices.push(...prices);
    }
    
    // Calculate average of filtered prices
    const avgPrice = filteredPrices.reduce((sum, p) => sum + p.price, 0) / filteredPrices.length;
    
    // Use the most recent timestamp
    const latestTimestamp = prices.reduce((latest, p) => 
      p.timestamp > latest ? p.timestamp : latest, 
      prices[0].timestamp
    );
    
    return {
      price: avgPrice,
      timestamp: latestTimestamp,
      source: 'aggregated',
      confidence: this.calculateConfidence(prices, filteredPrices)
    };
  }
  
  private calculateConfidence(allPrices: PriceData[], filteredPrices: PriceData[]): number {
    // Confidence based on:
    // 1. Number of sources (more is better)
    // 2. Price variance (less is better)
    // 3. Source health
    
    const sourceScore = filteredPrices.length / this.sources.size;
    
    const prices = filteredPrices.map(p => p.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    const varianceScore = 1 - Math.min(stdDev / avg, 1);
    
    const healthySourcesCount = Array.from(this.sources.values())
      .filter(s => s.isHealthy()).length;
    const healthScore = healthySourcesCount / this.sources.size;
    
    return (sourceScore * 0.4 + varianceScore * 0.4 + healthScore * 0.2);
  }
  
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Price aggregator is already running');
      return;
    }
    
    this.isRunning = true;
    console.log('Starting price aggregator...');
    
    // Initial fetch
    try {
      const price = await this.getCurrentPrice();
      console.log(`Initial SOL/USD price: $${price.price.toFixed(4)}`);
    } catch (error) {
      console.error('Failed to fetch initial price:', error);
    }
    
    // Set up periodic updates
    this.updateInterval = setInterval(async () => {
      try {
        await this.getCurrentPrice();
      } catch (error) {
        console.error('Failed to update price:', error);
      }
    }, this.config.updateInterval);
  }
  
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
    this.isRunning = false;
    console.log('Price aggregator stopped');
  }
  
  getHealthStatus(): {
    sources: { name: string; healthy: boolean; lastError: string | null }[];
    cacheSize: number;
    isRunning: boolean;
  } {
    const sources = Array.from(this.sources.entries()).map(([name, source]) => ({
      name,
      healthy: source.isHealthy(),
      lastError: source.getLastError()?.message || null
    }));
    
    return {
      sources,
      cacheSize: this.cache.size(),
      isRunning: this.isRunning
    };
  }
}