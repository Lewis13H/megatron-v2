import { getDbPool } from '../database/connection';
import { JupiterSolPriceService } from '../services/price/jupiter-sol-price-service';
import { HermesPriceService } from '../services/price/hermes-price-service';
import { SolPriceService, SolPriceData } from '../services/price/sol-price-service';

export class SolPriceUpdater {
    private pool = getDbPool();
    private hermesService: HermesPriceService;
    private jupiterService: JupiterSolPriceService;
    private isRunning = false;
    private jupiterIntervalId?: NodeJS.Timeout;
    private hermesIntervalId?: NodeJS.Timeout;
    
    constructor() {
        this.hermesService = new HermesPriceService();
        this.jupiterService = new JupiterSolPriceService();
    }
    
    async start(): Promise<void> {
        if (this.isRunning) {
            console.log('SOL price updater is already running');
            return;
        }
        
        console.log('Starting SOL price updater...');
        this.isRunning = true;
        
        try {
            // Start Hermes periodic updates (every 5 seconds)
            this.hermesService.startPriceUpdates(5000);
            console.log('✓ Started Hermes (Pyth) price updates (5s interval)');
            
            // Start Jupiter periodic updates (every 30 seconds)
            this.startJupiterUpdates();
            console.log('✓ Started Jupiter price updates (30s interval)');
            
            // Subscribe to price updates for logging
            this.hermesService.subscribeToUpdates((price) => {
                this.logPriceUpdate('Hermes', price);
            });
            
            this.jupiterService.subscribeToUpdates((price) => {
                this.logPriceUpdate('Jupiter', price);
            });
            
            console.log('\n✅ SOL price updater started successfully!');
            
            // Show current prices
            await this.showCurrentPrices();
            
        } catch (error) {
            console.error('Failed to start SOL price updater:', error);
            this.isRunning = false;
            throw error;
        }
    }
    
    async stop(): Promise<void> {
        if (!this.isRunning) {
            console.log('SOL price updater is not running');
            return;
        }
        
        console.log('Stopping SOL price updater...');
        
        // Stop Hermes updates
        this.hermesService.stopPriceUpdates();
        
        // Stop Jupiter updates
        if (this.jupiterIntervalId) {
            clearInterval(this.jupiterIntervalId);
            this.jupiterIntervalId = undefined;
        }
        
        this.isRunning = false;
        console.log('✓ SOL price updater stopped');
    }
    
    private startJupiterUpdates(): void {
        // Initial fetch
        this.jupiterService.getCurrentPrice().catch(console.error);
        
        // Set up interval
        this.jupiterIntervalId = setInterval(async () => {
            try {
                await this.jupiterService.getCurrentPrice();
            } catch (error) {
                console.error('[Jupiter] Failed to update price:', error);
            }
        }, 30000); // 30 seconds
    }
    
    private logPriceUpdate(source: string, price: SolPriceData): void {
        const timestamp = price.timestamp.toISOString();
        const priceStr = `$${price.price.toFixed(4)}`;
        const confStr = price.confidence ? ` ±${price.confidence.toFixed(4)}` : '';
        
        console.log(`[${timestamp}] ${source}: SOL/USD ${priceStr}${confStr}`);
    }
    
    async showCurrentPrices(): Promise<void> {
        try {
            const hermesPrice = await this.hermesService.getCurrentPrice();
            const jupiterPrice = await this.jupiterService.getCurrentPrice();
            
            console.log('\nCurrent SOL/USD Prices:');
            console.log(`  Hermes:  $${hermesPrice.price.toFixed(4)}${hermesPrice.confidence ? ` ±${hermesPrice.confidence.toFixed(4)}` : ''}`);
            console.log(`  Jupiter: $${jupiterPrice.price.toFixed(4)}`);
            
            // Calculate spread
            const spread = Math.abs(hermesPrice.price - jupiterPrice.price);
            const spreadPct = (spread / Math.min(hermesPrice.price, jupiterPrice.price)) * 100;
            console.log(`  Spread:  $${spread.toFixed(4)} (${spreadPct.toFixed(2)}%)`);
        } catch (error) {
            console.error('Error fetching current prices:', error);
        }
    }
    
    async backfillHistoricalPrices(startDate: Date, endDate: Date): Promise<void> {
        console.log(`Backfilling historical SOL/USD prices from ${startDate.toISOString()} to ${endDate.toISOString()}`);
        
        // For now, this is a placeholder
        // In a real implementation, you would:
        // 1. Fetch historical data from APIs that support it (like Birdeye or CoinGecko)
        // 2. Insert the data into sol_usd_prices table
        // 3. Update existing transactions and price candles with USD values
        
        console.log('Historical backfill not yet implemented');
    }
    
    async updateTransactionUsdValues(batchSize: number = 1000): Promise<number> {
        console.log('Updating transaction USD values...');
        
        try {
            const result = await this.pool.query(
                'SELECT * FROM backfill_transaction_usd_values(NULL, NULL, $1)',
                [batchSize]
            );
            
            const updatedCount = result.rows[0]?.updated_count || 0;
            console.log(`✓ Updated ${updatedCount} transactions with USD values`);
            
            return updatedCount;
        } catch (error) {
            console.error('Error updating transaction USD values:', error);
            throw error;
        }
    }
    
    async getHealthStatus(): Promise<any> {
        try {
            const result = await this.pool.query('SELECT * FROM sol_usd_price_health');
            return result.rows;
        } catch (error) {
            console.error('Error fetching health status:', error);
            return [];
        }
    }
}

// CLI runner
if (require.main === module) {
    const updater = new SolPriceUpdater();
    
    // Handle shutdown gracefully
    process.on('SIGINT', async () => {
        console.log('\nReceived SIGINT, shutting down gracefully...');
        await updater.stop();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        console.log('\nReceived SIGTERM, shutting down gracefully...');
        await updater.stop();
        process.exit(0);
    });
    
    // Start the updater
    updater.start().catch((error) => {
        console.error('Failed to start SOL price updater:', error);
        process.exit(1);
    });
    
    // Keep the process running
    console.log('\nSOL price updater is running. Press Ctrl+C to stop.\n');
}