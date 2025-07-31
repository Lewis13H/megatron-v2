import { HermesClient } from '@pythnetwork/hermes-client';
import { BaseSolPriceService, SolPriceData } from './sol-price-service';

// SOL/USD price feed ID from Pyth
const SOL_USD_PRICE_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

export class HermesPriceService extends BaseSolPriceService {
    private hermesClient: HermesClient;
    private intervalId?: NodeJS.Timeout;
    
    constructor(hermesUrl?: string) {
        super();
        this.hermesClient = new HermesClient(
            hermesUrl || 'https://hermes.pyth.network',
            {}
        );
    }
    
    async getCurrentPrice(): Promise<SolPriceData> {
        try {
            // Fetch latest price updates from Hermes
            const response = await this.hermesClient.getLatestPriceUpdates(
                [SOL_USD_PRICE_FEED_ID],
                { parsed: true }
            );
            
            if (!response || !response.parsed || response.parsed.length === 0) {
                throw new Error('No price data returned from Hermes');
            }
            
            const priceFeed = response.parsed[0];
            
            if (!priceFeed.price) {
                throw new Error('Invalid price data from Hermes');
            }
            
            // Parse the price data
            const price = parseFloat(priceFeed.price.price) * Math.pow(10, priceFeed.price.expo);
            const confidence = parseFloat(priceFeed.price.conf) * Math.pow(10, priceFeed.price.expo);
            const timestamp = new Date(priceFeed.price.publish_time * 1000);
            
            const solPriceData: SolPriceData = {
                price,
                source: 'hermes',
                confidence,
                timestamp
            };
            
            // Save to database
            await this.savePriceUpdate(price, 'hermes', confidence);
            
            console.log(`[Hermes] SOL/USD price: $${price.toFixed(4)} ±${confidence.toFixed(4)}`);
            
            return solPriceData;
        } catch (error) {
            console.error('Error fetching price from Hermes:', error);
            
            // Try to get latest from database as fallback
            const dbPrice = await this.getLatestPriceFromDb('hermes');
            if (dbPrice) {
                console.log('Using cached Hermes price from database');
                return dbPrice;
            }
            
            throw error;
        }
    }
    
    async startPriceUpdates(intervalMs: number = 5000): Promise<void> {
        // Initial fetch
        await this.getCurrentPrice();
        
        // Set up interval
        this.intervalId = setInterval(async () => {
            try {
                const price = await this.getCurrentPrice();
                // Notify subscribers
                for (const callback of this.updateCallbacks) {
                    callback(price);
                }
            } catch (error) {
                console.error('[Hermes] Failed to update price:', error);
            }
        }, intervalMs);
    }
    
    stopPriceUpdates(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }
}