import { BaseSolPriceService, SolPriceData } from './sol-price-service';

const JUPITER_PRICE_API = 'https://price.jup.ag/v4/price';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const CACHE_DURATION_MS = 5000; // 5 seconds cache

export class JupiterSolPriceService extends BaseSolPriceService {
    private lastFetch: number = 0;
    private cachedPrice: SolPriceData | null = null;
    private fetchPromise: Promise<SolPriceData> | null = null;
    
    async getCurrentPrice(): Promise<SolPriceData> {
        const now = Date.now();
        
        // Return cached price if still fresh
        if (this.cachedPrice && (now - this.lastFetch) < CACHE_DURATION_MS) {
            return this.cachedPrice;
        }
        
        // If already fetching, return the existing promise
        if (this.fetchPromise) {
            return this.fetchPromise;
        }
        
        // Create new fetch promise
        this.fetchPromise = this.fetchPriceFromJupiter();
        
        try {
            const price = await this.fetchPromise;
            this.cachedPrice = price;
            this.lastFetch = now;
            return price;
        } finally {
            this.fetchPromise = null;
        }
    }
    
    private async fetchPriceFromJupiter(): Promise<SolPriceData> {
        try {
            const response = await fetch(`${JUPITER_PRICE_API}?ids=${SOL_MINT}`);
            
            if (!response.ok) {
                throw new Error(`Jupiter API error: ${response.status} ${response.statusText}`);
            }
            
            const data: any = await response.json();
            
            if (!data.data || !data.data[SOL_MINT]) {
                throw new Error('No price data for SOL in Jupiter response');
            }
            
            const solData = data.data[SOL_MINT];
            const price = solData.price;
            
            if (!price || typeof price !== 'number') {
                throw new Error('Invalid price data from Jupiter');
            }
            
            const priceData: SolPriceData = {
                price,
                source: 'jupiter',
                timestamp: new Date()
            };
            
            // Save to database
            await this.savePriceUpdate(price, 'jupiter');
            
            return priceData;
        } catch (error) {
            console.error('Error fetching price from Jupiter:', error);
            
            // Try to get latest from database as fallback
            const dbPrice = await this.getLatestPriceFromDb('jupiter');
            if (dbPrice) {
                console.log('Using cached Jupiter price from database');
                return dbPrice;
            }
            
            throw error;
        }
    }
    
    // Start periodic price updates
    startPriceUpdates(intervalMs: number = 30000): void {
        // Initial fetch
        this.getCurrentPrice().catch(console.error);
        
        // Set up interval
        const intervalId = setInterval(async () => {
            try {
                await this.getCurrentPrice();
                console.log(`[Jupiter] SOL price updated: $${this.cachedPrice?.price.toFixed(4)}`);
            } catch (error) {
                console.error('[Jupiter] Failed to update price:', error);
            }
        }, intervalMs);
        
        // Store interval ID for cleanup if needed
        (this as any).intervalId = intervalId;
    }
    
    stopPriceUpdates(): void {
        if ((this as any).intervalId) {
            clearInterval((this as any).intervalId);
            delete (this as any).intervalId;
        }
    }
}