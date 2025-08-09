import Client from '@triton-one/yellowstone-grpc';
import { ConnectionPool } from './connection-pool';

export abstract class MonitorAdapter {
  protected pool: ConnectionPool;
  protected monitorId: string;
  private client?: Client;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private baseReconnectDelay: number = 1000; // 1 second
  private maxReconnectDelay: number = 30000; // 30 seconds
  
  constructor(pool: ConnectionPool, monitorId: string) {
    this.pool = pool;
    this.monitorId = monitorId;
  }
  
  protected async getClient(): Promise<Client> {
    try {
      if (!this.client) {
        console.log(`[${this.monitorId}] Requesting connection from pool`);
        this.client = await this.pool.getConnection(this.monitorId);
        this.reconnectAttempts = 0;
        console.log(`[${this.monitorId}] Connection obtained successfully`);
      }
      return this.client;
    } catch (error) {
      console.error(`[${this.monitorId}] Connection error:`, error);
      this.client = undefined;
      
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        throw new Error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached for ${this.monitorId}`);
      }
      
      // Exponential backoff for reconnection
      const delay = Math.min(
        this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts), 
        this.maxReconnectDelay
      );
      this.reconnectAttempts++;
      
      console.log(`[${this.monitorId}] Retrying connection in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return this.getClient(); // Retry
    }
  }
  
  protected handleConnectionError(error: Error): void {
    console.error(`[${this.monitorId}] Stream error:`, error);
    this.client = undefined; // Force reconnection on next request
    this.pool.releaseConnection(this.monitorId);
  }
  
  async stop(): Promise<void> {
    console.log(`[${this.monitorId}] Stopping monitor`);
    if (this.client) {
      this.pool.releaseConnection(this.monitorId);
      this.client = undefined;
    }
  }
  
  // Abstract method that child classes must implement
  abstract start(): Promise<void>;
}