import { BasePriceSource } from './base-source';
import { PriceData, PriceSourceConfig } from '../types';

const BINANCE_API = 'https://api.binance.com/api/v3/ticker/price';
const SOL_SYMBOL = 'SOLUSDT';

export class BinancePriceSource extends BasePriceSource {
  constructor(config: PriceSourceConfig) {
    super('binance', config);
  }
  
  async fetchPrice(): Promise<PriceData> {
    const response = await fetch(`${BINANCE_API}?symbol=${SOL_SYMBOL}`);
    
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status}`);
    }
    
    const data: any = await response.json();
    
    if (!data?.price) {
      throw new Error('No price data in Binance response');
    }
    
    return {
      price: parseFloat(data.price),
      timestamp: new Date(),
      source: this.name
    };
  }
}