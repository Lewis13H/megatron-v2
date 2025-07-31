import { BaseSolPriceService, SolPriceData } from './sol-price-service';

// Mock service for testing when APIs are unavailable
export class MockSolPriceService extends BaseSolPriceService {
    private basePrice = 150; // Starting price
    private volatility = 0.5; // Price volatility percentage
    
    async getCurrentPrice(): Promise<SolPriceData> {
        // Simulate price fluctuation
        const change = (Math.random() - 0.5) * 2 * this.volatility;
        const price = this.basePrice * (1 + change / 100);
        
        const priceData: SolPriceData = {
            price,
            source: 'mock',
            confidence: Math.abs(change) * 0.01,
            timestamp: new Date()
        };
        
        // Save to database
        await this.savePriceUpdate(price, 'mock', priceData.confidence);
        
        // Update base price for next iteration
        this.basePrice = price;
        
        return priceData;
    }
    
    startMockUpdates(intervalMs: number = 5000): void {
        // Initial price
        this.getCurrentPrice().catch(console.error);
        
        // Set up interval
        const intervalId = setInterval(async () => {
            try {
                const price = await this.getCurrentPrice();
                console.log(`[Mock] SOL price: $${price.price.toFixed(4)} ±${price.confidence?.toFixed(4)}`);
            } catch (error) {
                console.error('[Mock] Failed to generate price:', error);
            }
        }, intervalMs);
        
        (this as any).intervalId = intervalId;
    }
    
    stopMockUpdates(): void {
        if ((this as any).intervalId) {
            clearInterval((this as any).intervalId);
            delete (this as any).intervalId;
        }
    }
}