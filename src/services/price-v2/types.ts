export interface PriceData {
  price: number;
  timestamp: Date;
  source: string;
  confidence?: number;
}

export interface PriceSourceConfig {
  priority: number;
  timeout: number;
  retryCount: number;
  retryDelay: number;
}

export interface PriceSource {
  name: string;
  fetchPrice(): Promise<PriceData>;
  isHealthy(): boolean;
  getLastError(): Error | null;
}

export interface PriceAggregatorConfig {
  sources: Map<string, PriceSourceConfig>;
  updateInterval: number;
  cacheTime: number;
  outlierThreshold: number; // % deviation from median to consider outlier
  minSources: number; // minimum sources required for valid price
}