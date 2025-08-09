import Client from '@triton-one/yellowstone-grpc';
import { RateLimiter } from './rate-limiter';
import { v4 as uuidv4 } from 'uuid';
import { ClientDuplexStream } from '@grpc/grpc-js';

export interface PoolConfig {
  grpcUrl: string;
  token: string;
  maxConnections: number;      // Default: 15
  connectionTTL: number;       // Default: 5 minutes in ms
  healthCheckInterval: number; // Default: 30 seconds in ms
}

export interface PooledConnection {
  id: string;
  client: Client;
  stream?: ClientDuplexStream<any, any>;  // Store the active stream
  createdAt: Date;
  lastUsed: Date;
  isHealthy: boolean;
  monitorId?: string;  // Which monitor is using it
}

export interface PoolStats {
  total: number;
  healthy: number;
  unhealthy: number;
  rateLimitRemaining: number;
  monitorConnections: Map<string, number>;
}

export class ConnectionPool {
  private connections: Map<string, PooledConnection>;
  private rateLimiter: RateLimiter;
  private config: PoolConfig;
  private healthCheckInterval?: NodeJS.Timeout;
  
  constructor(config: PoolConfig) {
    this.connections = new Map();
    this.rateLimiter = new RateLimiter(60, 60000); // 60 per minute
    this.config = config;
    this.startHealthCheck();
  }
  
  async getConnection(monitorId: string): Promise<Client> {
    // First, try to find existing connection for this monitor
    const existing = this.findMonitorConnection(monitorId);
    if (existing && existing.isHealthy) {
      existing.lastUsed = new Date();
      console.log(`[Pool] Reusing connection ${existing.id} for ${monitorId}`);
      return existing.client;
    }
    
    // Remove unhealthy connection if exists
    if (existing && !existing.isHealthy) {
      console.log(`[Pool] Removing unhealthy connection ${existing.id} for ${monitorId}`);
      await this.closeConnection(existing);
    }
    
    // Create new connection if under limit
    if (this.connections.size < this.config.maxConnections) {
      return await this.createConnection(monitorId);
    }
    
    // Find least recently used connection to reassign
    const lru = this.findLRUConnection();
    if (lru) {
      console.log(`[Pool] Reassigning connection ${lru.id} from ${lru.monitorId} to ${monitorId}`);
      // Close the existing stream before reassigning
      await this.cancelStream(lru);
      lru.monitorId = monitorId;
      lru.lastUsed = new Date();
      return lru.client;
    }
    
    throw new Error('No connections available');
  }
  
  // Store stream reference for a connection
  setStream(monitorId: string, stream: ClientDuplexStream<any, any>): void {
    const conn = this.findMonitorConnection(monitorId);
    if (conn) {
      conn.stream = stream;
      console.log(`[Pool] Stream registered for ${monitorId} (connection ${conn.id})`);
      
      // Set up stream error handling
      stream.on('error', (err: any) => {
        if (err.code === 1 || err.message?.includes('Cancelled')) {
          // This is expected when we cancel the stream
          console.log(`[Pool] Stream cancelled for ${monitorId}`);
        } else {
          console.error(`[Pool] Stream error for ${monitorId}:`, err);
          conn.isHealthy = false;
        }
      });
      
      stream.on('close', () => {
        console.log(`[Pool] Stream closed for ${monitorId}`);
        conn.stream = undefined;
      });
      
      stream.on('end', () => {
        console.log(`[Pool] Stream ended for ${monitorId}`);
        conn.stream = undefined;
      });
    }
  }
  
  private async createConnection(monitorId: string): Promise<Client> {
    // Check rate limit
    if (!await this.rateLimiter.tryAcquire()) {
      throw new Error('Rate limit exceeded - please wait before creating new connections');
    }
    
    console.log(`[Pool] Creating new connection for ${monitorId}`);
    
    const client = new Client(this.config.grpcUrl, this.config.token, undefined);
    const connection: PooledConnection = {
      id: uuidv4(),
      client,
      createdAt: new Date(),
      lastUsed: new Date(),
      isHealthy: true,
      monitorId
    };
    
    this.connections.set(connection.id, connection);
    console.log(`[Pool] Created connection ${connection.id} for ${monitorId} (${this.connections.size}/${this.config.maxConnections} total)`);
    
    return client;
  }
  
  async releaseConnection(monitorId: string): Promise<void> {
    const conn = this.findMonitorConnection(monitorId);
    if (conn) {
      // Cancel any active stream
      await this.cancelStream(conn);
      conn.lastUsed = new Date();
      console.log(`[Pool] Released connection ${conn.id} from ${monitorId}`);
    }
  }
  
  // Properly cancel a stream
  private async cancelStream(conn: PooledConnection): Promise<void> {
    if (conn.stream) {
      try {
        console.log(`[Pool] Cancelling stream for connection ${conn.id}`);
        conn.stream.cancel();
        
        // Wait a bit for the cancellation to complete
        await new Promise(resolve => setTimeout(resolve, 100));
        
        conn.stream = undefined;
        console.log(`[Pool] Stream cancelled successfully for connection ${conn.id}`);
      } catch (error: any) {
        // Handle expected errors from cancellation
        if (error.code === 1 || error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.message?.includes('Cancelled')) {
          console.log(`[Pool] Stream cancelled (expected error) for connection ${conn.id}`);
        } else {
          console.error(`[Pool] Error cancelling stream for connection ${conn.id}:`, error);
        }
        conn.stream = undefined;
      }
    }
  }
  
  // Properly close a connection
  private async closeConnection(conn: PooledConnection): Promise<void> {
    try {
      // First, cancel any active stream
      await this.cancelStream(conn);
      
      // Remove from connections map
      this.connections.delete(conn.id);
      
      console.log(`[Pool] Connection ${conn.id} closed completely`);
    } catch (error) {
      console.error(`[Pool] Error closing connection ${conn.id}:`, error);
      // Still remove it from the map even if there was an error
      this.connections.delete(conn.id);
    }
  }
  
  private findMonitorConnection(monitorId: string): PooledConnection | undefined {
    return Array.from(this.connections.values()).find(c => c.monitorId === monitorId);
  }
  
  private findLRUConnection(): PooledConnection | undefined {
    let lru: PooledConnection | undefined;
    let oldestTime = new Date();
    
    for (const conn of this.connections.values()) {
      if (conn.lastUsed < oldestTime && conn.isHealthy) {
        lru = conn;
        oldestTime = conn.lastUsed;
      }
    }
    
    return lru;
  }
  
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkConnectionHealth();
    }, this.config.healthCheckInterval);
  }
  
  private async checkConnectionHealth(): Promise<void> {
    for (const [id, conn] of this.connections.entries()) {
      try {
        // Check if connection is expired (TTL)
        const age = Date.now() - conn.createdAt.getTime();
        if (age > this.config.connectionTTL) {
          console.log(`[Pool] Connection ${id} expired (age: ${Math.round(age/1000)}s)`);
          conn.isHealthy = false;
          await this.handleUnhealthyConnection(conn);
          continue;
        }
        
        // Simple health check - could be enhanced with actual ping
        conn.isHealthy = true;
      } catch (error) {
        console.error(`[Pool] Connection ${id} unhealthy:`, error);
        conn.isHealthy = false;
        await this.handleUnhealthyConnection(conn);
      }
    }
  }
  
  private async handleUnhealthyConnection(conn: PooledConnection): Promise<void> {
    // Close the connection properly
    await this.closeConnection(conn);
    
    // If it was assigned to a monitor, mark for reconnection
    if (conn.monitorId) {
      console.log(`[Pool] Monitor ${conn.monitorId} needs reconnection`);
      // Monitor will request new connection on next operation
    }
  }
  
  getStats(): PoolStats {
    const healthy = Array.from(this.connections.values())
      .filter(c => c.isHealthy).length;
    
    const monitorConnections = new Map<string, number>();
    for (const conn of this.connections.values()) {
      if (conn.monitorId) {
        monitorConnections.set(
          conn.monitorId, 
          (monitorConnections.get(conn.monitorId) || 0) + 1
        );
      }
    }
    
    return {
      total: this.connections.size,
      healthy,
      unhealthy: this.connections.size - healthy,
      rateLimitRemaining: this.rateLimiter.getAvailableTokens(),
      monitorConnections
    };
  }
  
  async shutdown(): Promise<void> {
    console.log('[Pool] Shutting down connection pool');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    // Close all connections properly
    const closePromises: Promise<void>[] = [];
    for (const [id, conn] of this.connections.entries()) {
      closePromises.push(this.closeConnection(conn));
    }
    
    // Wait for all connections to close
    await Promise.all(closePromises);
    
    console.log('[Pool] Connection pool shutdown complete');
  }
}