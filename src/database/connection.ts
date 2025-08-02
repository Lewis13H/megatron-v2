import { Pool, PoolClient } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

// Enhanced database connection class with retry logic
export class DatabaseConnection {
  private static pool: Pool | null = null;
  
  static getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'megatron_v2',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        max: 20, // Maximum number of clients in the pool
        idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
        connectionTimeoutMillis: 5000, // Increase from 2000ms to 5000ms
      });
      
      // Add basic error recovery - don't exit, just log
      this.pool.on('error', (err) => {
        console.error('Pool error:', err);
      });
      
      // Log when connected
      this.pool.on('connect', () => {
        console.log('Database pool: new client connected');
      });
    }
    return this.pool;
  }
  
  // Simple retry wrapper
  static async withRetry<T>(
    operation: () => Promise<T>, 
    retries = 3
  ): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await operation();
      } catch (error: any) {
        if (i === retries - 1 || !this.isRetryable(error)) throw error;
        console.log(`Retrying operation (attempt ${i + 2}/${retries}) after error:`, error.message);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    throw new Error('Max retries exceeded');
  }
  
  private static isRetryable(error: any): boolean {
    return error.code === 'ECONNREFUSED' || 
           error.code === 'ETIMEDOUT' ||
           error.code === 'ENOTFOUND' ||
           error.message?.includes('Connection terminated') ||
           error.message?.includes('pool ended');
  }
  
  // Close the pool
  static async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      console.log('Database pool closed');
    }
  }
}

// Export convenient shorthand
export const db = DatabaseConnection;

// Maintain backward compatibility
export function getDbPool(): Pool {
  return DatabaseConnection.getPool();
}

// Graceful shutdown
export async function closeDbPool(): Promise<void> {
  await DatabaseConnection.close();
}

// Handle process termination
process.on('SIGINT', async () => {
  await closeDbPool();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeDbPool();
  process.exit(0);
});