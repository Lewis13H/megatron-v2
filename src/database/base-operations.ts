import { PoolClient, QueryResult } from 'pg';
import { db } from './connection';

export class BaseOperations {
  protected pool = db.getPool();
  
  // Simple transaction helper
  async executeInTransaction<T>(
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // Query with retry
  async query(text: string, params?: any[]): Promise<QueryResult> {
    return db.withRetry(() => this.pool.query(text, params));
  }
  
  // Query one result with retry
  async queryOne<T>(text: string, params?: any[]): Promise<T | null> {
    const result = await this.query(text, params);
    return result.rows[0] || null;
  }
  
  // Query many results with retry
  async queryMany<T>(text: string, params?: any[]): Promise<T[]> {
    const result = await this.query(text, params);
    return result.rows;
  }
  
  // Execute query without expecting results (INSERT, UPDATE, DELETE)
  async execute(text: string, params?: any[]): Promise<number> {
    const result = await this.query(text, params);
    return result.rowCount || 0;
  }
  
  // Helper to format arrays for PostgreSQL
  protected formatArray(arr: any[]): string {
    return `{${arr.join(',')}}`;
  }
  
  // Helper to safely handle BigInt conversion
  protected safeBigInt(value: any): string | null {
    if (value === null || value === undefined) return null;
    return value.toString();
  }
}