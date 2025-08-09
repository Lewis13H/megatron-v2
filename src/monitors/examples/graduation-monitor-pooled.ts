/**
 * Example: Graduation Monitor migrated to use gRPC Connection Pool
 * 
 * This demonstrates how to migrate an existing monitor to use the connection pool.
 * Compare this with the original graduation-monitor.ts to see the changes.
 */

import { MonitorAdapter } from '../../grpc/monitor-adapter';
import { grpcPool } from '../../grpc';
import { SubscribeRequestFilterTransactions, SubscribeRequest } from '@triton-one/yellowstone-grpc';
import { SolanaParser } from '@shyft-to/solana-transaction-parser';
import { Connection, PublicKey } from '@solana/web3.js';
import { monitorService } from '../../database';

// Program IDs
const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RAYDIUM_MIGRATION_PROGRAM = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';

export class GraduationMonitorPooled extends MonitorAdapter {
  private connection: Connection;
  private txParser: SolanaParser;
  
  constructor() {
    // Pass the pool and a unique monitor ID to the base class
    super(grpcPool, 'graduation-monitor');
    
    this.connection = new Connection('https://api.mainnet-beta.solana.com');
    this.txParser = new SolanaParser([]);
  }
  
  async start(): Promise<void> {
    console.log('[Graduation Monitor] Starting with connection pool...');
    
    try {
      // Get client from pool instead of creating directly
      const client = await this.getClient();
      
      // Set up subscription filters
      const filter: SubscribeRequestFilterTransactions = {
        vote: false,
        failed: false,
        accountInclude: [PUMPFUN_PROGRAM],
        accountExclude: [],
        accountRequired: []
      };
      
      const request: SubscribeRequest = {
        accounts: {},
        slots: {},
        transactions: {
          graduationFilter: filter
        },
        transactionsStatus: {},
        entry: {},
        blocks: {},
        blocksMeta: {},
        accountsDataSlice: [],
        ping: undefined
      };
      
      // Subscribe to transactions
      const stream = await client.subscribe();
      
      // Send the subscription request
      await new Promise<void>((resolve, reject) => {
        stream.write(request, (err: any) => {
          if (err === null || err === undefined) {
            resolve();
          } else {
            reject(err);
          }
        });
      });
      
      console.log('[Graduation Monitor] Subscription established via pool');
      
      stream.on('data', (data: any) => {
        if (data.transaction) {
          this.processTransaction(data.transaction);
        }
      });
      
      stream.on('error', (error: Error) => {
        console.error('[Graduation Monitor] Stream error:', error);
        // Use the base class error handler which will manage reconnection
        this.handleConnectionError(error);
      });
      
      stream.on('end', () => {
        console.log('[Graduation Monitor] Stream ended');
        // The base class will handle reconnection
        this.handleConnectionError(new Error('Stream ended'));
      });
      
      stream.on('close', () => {
        console.log('[Graduation Monitor] Stream closed');
        // The base class will handle reconnection
        this.handleConnectionError(new Error('Stream closed'));
      });
      
    } catch (error) {
      console.error('[Graduation Monitor] Failed to start:', error);
      // The base class will handle reconnection with exponential backoff
      this.handleConnectionError(error as Error);
    }
  }
  
  private async processTransaction(transaction: any): Promise<void> {
    try {
      // Look for migration to Raydium
      const hasRaydiumMigration = transaction.transaction?.message?.accountKeys?.some(
        (key: any) => key === RAYDIUM_MIGRATION_PROGRAM
      );
      
      if (hasRaydiumMigration) {
        console.log('[Graduation Monitor] Detected token graduation!');
        
        // Extract token mint from transaction
        const tokenMint = this.extractTokenMint(transaction);
        
        if (tokenMint) {
          // Save graduation event
          await this.saveGraduationEvent(tokenMint, transaction);
        }
      }
    } catch (error) {
      console.error('[Graduation Monitor] Error processing transaction:', error);
    }
  }
  
  private extractTokenMint(transaction: any): string | null {
    // Implementation to extract token mint from transaction
    // This would parse the transaction to find the token mint address
    return null; // Placeholder
  }
  
  private async saveGraduationEvent(tokenMint: string, transaction: any): Promise<void> {
    try {
      console.log(`[Graduation Monitor] Saving graduation for token: ${tokenMint}`);
      
      // Save to database using the monitor service
      // await monitorService.saveGraduationEvent({
      //   token_mint: tokenMint,
      //   transaction_signature: transaction.signature,
      //   graduated_at: new Date(),
      //   migration_type: 'raydium',
      //   ...
      // });
      
      console.log(`[Graduation Monitor] Graduation saved for ${tokenMint}`);
    } catch (error) {
      console.error('[Graduation Monitor] Failed to save graduation:', error);
    }
  }
}

// Example usage:
// const graduationMonitor = new GraduationMonitorPooled();
// await graduationMonitor.start();
// 
// // Later, to stop:
// await graduationMonitor.stop();