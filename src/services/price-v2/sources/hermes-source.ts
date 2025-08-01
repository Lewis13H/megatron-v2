import { HermesClient } from '@pythnetwork/hermes-client';
import { BasePriceSource } from './base-source';
import { PriceData, PriceSourceConfig } from '../types';

const SOL_USD_PRICE_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

export class HermesPriceSource extends BasePriceSource {
  private hermesClient: HermesClient;
  
  constructor(config: PriceSourceConfig, hermesUrl?: string) {
    super('hermes', config);
    this.hermesClient = new HermesClient(
      hermesUrl || 'https://hermes.pyth.network',
      {}
    );
  }
  
  async fetchPrice(): Promise<PriceData> {
    const response = await this.hermesClient.getLatestPriceUpdates(
      [SOL_USD_PRICE_FEED_ID],
      { parsed: true }
    );
    
    if (!response?.parsed?.length || !response.parsed[0].price) {
      throw new Error('No price data from Hermes');
    }
    
    const priceFeed = response.parsed[0];
    const price = parseFloat(priceFeed.price.price) * Math.pow(10, priceFeed.price.expo);
    const confidence = parseFloat(priceFeed.price.conf) * Math.pow(10, priceFeed.price.expo);
    
    return {
      price,
      timestamp: new Date(priceFeed.price.publish_time * 1000),
      source: this.name,
      confidence
    };
  }
}