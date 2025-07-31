import { Connection, PublicKey } from '@solana/web3.js';
import { parsePriceData } from '@pythnetwork/client';
import { BaseSolPriceService, SolPriceData } from './sol-price-service';

// Pyth SOL/USD price feed on mainnet
const PYTH_SOL_USD_PRICE_FEED = new PublicKey('H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG');

export class PythSimplePriceService extends BaseSolPriceService {
    private connection: Connection;
    
    constructor(rpcUrl?: string) {
        super();
        this.connection = new Connection(
            rpcUrl || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
    }
    
    async getCurrentPrice(): Promise<SolPriceData> {
        try {
            // Fetch the account info
            const accountInfo = await this.connection.getAccountInfo(PYTH_SOL_USD_PRICE_FEED);
            
            if (!accountInfo) {
                throw new Error('Pyth price feed account not found');
            }
            
            // Parse the price data using Pyth's parser
            const priceData = parsePriceData(accountInfo.data);
            
            // Use aggregate price which is the most reliable
            const price = priceData.aggregate?.price;
            const confidence = priceData.aggregate?.confidence;
            
            if (!price || price === 0) {
                throw new Error('Invalid price data from Pyth - no aggregate price available');
            }
            
            // The aggregate price is already in the correct format (USD)
            
            const solPriceData: SolPriceData = {
                price,
                source: 'pyth',
                confidence,
                timestamp: priceData.timestamp ? new Date(Number(priceData.timestamp) * 1000) : new Date()
            };
            
            // Save to database
            await this.savePriceUpdate(price, 'pyth', confidence);
            
            console.log(`[Pyth] SOL/USD price: $${price.toFixed(4)} ±${confidence.toFixed(4)}`);
            
            return solPriceData;
        } catch (error) {
            console.error('Error fetching price from Pyth:', error);
            
            // Try to get latest from database as fallback
            const dbPrice = await this.getLatestPriceFromDb('pyth');
            if (dbPrice) {
                console.log('Using cached Pyth price from database');
                return dbPrice;
            }
            
            throw error;
        }
    }
    
    async startPriceUpdates(intervalMs: number = 5000): Promise<void> {
        // Initial fetch
        await this.getCurrentPrice();
        
        // Set up interval
        const intervalId = setInterval(async () => {
            try {
                await this.getCurrentPrice();
            } catch (error) {
                console.error('[Pyth] Failed to update price:', error);
            }
        }, intervalMs);
        
        (this as any).intervalId = intervalId;
    }
    
    stopPriceUpdates(): void {
        if ((this as any).intervalId) {
            clearInterval((this as any).intervalId);
            delete (this as any).intervalId;
        }
    }
}