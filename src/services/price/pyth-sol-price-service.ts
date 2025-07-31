import { Connection, PublicKey } from '@solana/web3.js';
import { getPythProgramKeyForCluster, PythConnection, PriceStatus } from '@pythnetwork/client';
import { BaseSolPriceService, SolPriceData } from './sol-price-service';

// Pyth SOL/USD price feed on mainnet
const PYTH_SOL_USD_PRICE_FEED = new PublicKey('H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG');

export class PythSolPriceService extends BaseSolPriceService {
    private connection: Connection;
    private priceSubscriptionId: number | null = null;
    private lastPrice: SolPriceData | null = null;
    
    constructor(rpcUrl?: string) {
        super();
        this.connection = new Connection(
            rpcUrl || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
    }
    
    async getCurrentPrice(): Promise<SolPriceData> {
        try {
            const priceData = await this.fetchPriceFromPyth();
            this.lastPrice = priceData;
            
            // Save to database
            await this.savePriceUpdate(
                priceData.price,
                'pyth',
                priceData.confidence
            );
            
            return priceData;
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
    
    private async fetchPriceFromPyth(): Promise<SolPriceData> {
        const accountInfo = await this.connection.getAccountInfo(PYTH_SOL_USD_PRICE_FEED);
        
        if (!accountInfo) {
            throw new Error('Pyth price feed account not found');
        }
        
        // Parse Pyth price data
        const priceData = this.parsePythPriceData(accountInfo.data);
        
        if (priceData.status !== 1) {
            throw new Error('Pyth price data is not valid (status != 1)');
        }
        
        return {
            price: priceData.price,
            source: 'pyth',
            confidence: priceData.confidence,
            timestamp: new Date(priceData.publishTime * 1000)
        };
    }
    
    private parsePythPriceData(data: Buffer): any {
        // Pyth price account layout (simplified)
        // This is a basic parser - in production, use @pythnetwork/client
        
        // Skip to price data offset (this is approximate - real implementation should use proper layout)
        const priceOffset = 48;
        const exponentOffset = 20;
        
        // Read price components
        const rawPrice = data.readBigInt64LE(priceOffset);
        const expo = data.readInt32LE(priceOffset + exponentOffset);
        const confidence = data.readBigUInt64LE(priceOffset + 8);
        const status = data.readUInt32LE(priceOffset + 16);
        const publishTime = data.readBigInt64LE(priceOffset + 24);
        
        // Convert price with exponent
        const price = Number(rawPrice) * Math.pow(10, expo);
        const conf = Number(confidence) * Math.pow(10, expo);
        
        return {
            price,
            confidence: conf,
            status,
            publishTime: Number(publishTime)
        };
    }
    
    // Subscribe to real-time price updates
    async subscribeToPriceUpdates(): Promise<void> {
        if (this.priceSubscriptionId !== null) {
            console.log('Already subscribed to Pyth price updates');
            return;
        }
        
        try {
            this.priceSubscriptionId = this.connection.onAccountChange(
                PYTH_SOL_USD_PRICE_FEED,
                async (accountInfo) => {
                    try {
                        const priceData = this.parsePythPriceData(accountInfo.data);
                        
                        if (priceData.status !== 1) {
                            console.warn('Received invalid Pyth price data (status != 1)');
                            return;
                        }
                        
                        const solPriceData: SolPriceData = {
                            price: priceData.price,
                            source: 'pyth',
                            confidence: priceData.confidence,
                            timestamp: new Date(priceData.publishTime * 1000)
                        };
                        
                        this.lastPrice = solPriceData;
                        
                        // Save to database
                        await this.savePriceUpdate(
                            solPriceData.price,
                            'pyth',
                            solPriceData.confidence
                        );
                        
                        console.log(`[Pyth] SOL price updated: $${solPriceData.price.toFixed(4)} ±${solPriceData.confidence?.toFixed(4)}`);
                    } catch (error) {
                        console.error('Error processing Pyth price update:', error);
                    }
                },
                'confirmed'
            );
            
            console.log('Subscribed to Pyth SOL/USD price feed');
            
            // Fetch initial price
            await this.getCurrentPrice();
        } catch (error) {
            console.error('Error subscribing to Pyth price updates:', error);
            throw error;
        }
    }
    
    // Unsubscribe from price updates
    async unsubscribeFromPriceUpdates(): Promise<void> {
        if (this.priceSubscriptionId !== null) {
            await this.connection.removeAccountChangeListener(this.priceSubscriptionId);
            this.priceSubscriptionId = null;
            console.log('Unsubscribed from Pyth price updates');
        }
    }
    
    async cleanup(): Promise<void> {
        await this.unsubscribeFromPriceUpdates();
        this.unsubscribe();
    }
}