import { PriceAggregatorConfig } from './types';

export const defaultConfig: PriceAggregatorConfig = {
  sources: new Map([
    ['hermes', { priority: 1, timeout: 5000, retryCount: 3, retryDelay: 1000 }],
    ['binance', { priority: 2, timeout: 10000, retryCount: 2, retryDelay: 2000 }],
  ]),
  updateInterval: 2000, // 2 seconds - well within Binance's 100 req/s limit
  cacheTime: 1500, // 1.5 seconds cache to prevent duplicate requests
  outlierThreshold: 0.05, // 5% deviation
  minSources: 1, // at least 1 source required
};

export function loadConfig(): PriceAggregatorConfig {
  // Allow environment variables to override defaults
  const updateInterval = process.env.SOL_PRICE_UPDATE_INTERVAL 
    ? parseInt(process.env.SOL_PRICE_UPDATE_INTERVAL) 
    : defaultConfig.updateInterval;
    
  const cacheTime = process.env.SOL_PRICE_CACHE_TIME
    ? parseInt(process.env.SOL_PRICE_CACHE_TIME)
    : defaultConfig.cacheTime;
  
  return {
    ...defaultConfig,
    updateInterval,
    cacheTime
  };
}