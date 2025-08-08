# gRPC Connection Pool - Phase 1: Lightweight MVP

## Overview

Phase 1 implements a minimal viable connection pool that solves the immediate rate limit problem for the current 7 monitors. This phase focuses on simplicity, reliability, and establishing the foundation for future enhancements.

## Goals

- Prevent rate limit violations (60 connections/60 seconds)
- Support current 7 monitors with dedicated connections
- Provide basic connection lifecycle management
- Implement simple health checking and reconnection
- Minimal code changes to existing monitors

## Architecture

### Simple Pool Design

```
┌─────────────────────────────────────────┐
│            Monitor Layer                 │
├────────────────┬────────────────────────┤
│   7 Monitors   │   (Direct Access)      │
└────────┬───────┴────────────────────────┘
         │
    ┌────▼─────────────┐
    │  Connection Pool │
    │   (Simple FIFO)  │
    └────┬─────────────┘
         │
    ┌────▼─────────────┐
    │  Rate Limiter    │
    │ (Token Bucket)   │
    └────┬─────────────┘
         │
    ┌────▼─────────────┐
    │ gRPC Connections │
    └──────────────────┘
```

## Implementation Details

### 1. Core Components

#### Connection Pool Manager (`src/grpc/connection-pool.ts`)

```typescript
import { Client } from '@triton-one/yellowstone-grpc';

interface PoolConfig {
  grpcUrl: string;
  token: string;
  maxConnections: number;      // Default: 15
  connectionTTL: number;       // Default: 5 minutes
  healthCheckInterval: number; // Default: 30 seconds
}

interface PooledConnection {
  id: string;
  client: Client;
  createdAt: Date;
  lastUsed: Date;
  isHealthy: boolean;
  monitorId?: string;  // Which monitor is using it
}

class ConnectionPool {
  private connections: Map<string, PooledConnection>;
  private rateLimiter: RateLimiter;
  private config: PoolConfig;
  
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
      return existing.client;
    }
    
    // Create new connection if under limit
    if (this.connections.size < this.config.maxConnections) {
      return await this.createConnection(monitorId);
    }
    
    // Find least recently used connection to reassign
    const lru = this.findLRUConnection();
    if (lru) {
      lru.monitorId = monitorId;
      lru.lastUsed = new Date();
      return lru.client;
    }
    
    throw new Error('No connections available');
  }
  
  private async createConnection(monitorId: string): Promise<Client> {
    // Check rate limit
    if (!await this.rateLimiter.tryAcquire()) {
      throw new Error('Rate limit exceeded');
    }
    
    const client = new Client(this.config.grpcUrl, this.config.token);
    const connection: PooledConnection = {
      id: generateId(),
      client,
      createdAt: new Date(),
      lastUsed: new Date(),
      isHealthy: true,
      monitorId
    };
    
    this.connections.set(connection.id, connection);
    console.log(`[Pool] Created connection ${connection.id} for ${monitorId}`);
    
    return client;
  }
  
  releaseConnection(monitorId: string): void {
    // In Phase 1, connections stay assigned to monitors
    // Just mark as available for reuse if needed
    const conn = this.findMonitorConnection(monitorId);
    if (conn) {
      conn.lastUsed = new Date();
    }
  }
  
  private startHealthCheck(): void {
    setInterval(() => {
      this.connections.forEach(async (conn) => {
        try {
          // Simple ping check
          await conn.client.ping();
          conn.isHealthy = true;
        } catch (error) {
          console.error(`[Pool] Connection ${conn.id} unhealthy:`, error);
          conn.isHealthy = false;
          this.handleUnhealthyConnection(conn);
        }
      });
    }, this.config.healthCheckInterval);
  }
  
  private handleUnhealthyConnection(conn: PooledConnection): void {
    // Remove unhealthy connection
    this.connections.delete(conn.id);
    
    // If it was assigned to a monitor, mark for reconnection
    if (conn.monitorId) {
      console.log(`[Pool] Monitor ${conn.monitorId} needs reconnection`);
      // Monitor will request new connection on next operation
    }
  }
  
  getStats(): PoolStats {
    const healthy = Array.from(this.connections.values())
      .filter(c => c.isHealthy).length;
    
    return {
      total: this.connections.size,
      healthy,
      unhealthy: this.connections.size - healthy,
      rateLimitRemaining: this.rateLimiter.getAvailableTokens(),
      monitorConnections: this.getMonitorConnectionMap()
    };
  }
}
```

#### Rate Limiter (`src/grpc/rate-limiter.ts`)

```typescript
class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number;
  private windowMs: number;
  private lastRefill: number;
  
  constructor(maxTokens: number, windowMs: number) {
    this.tokens = maxTokens;
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;
    this.refillRate = maxTokens / windowMs;
    this.lastRefill = Date.now();
  }
  
  async tryAcquire(count: number = 1): Promise<boolean> {
    this.refill();
    
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    
    return false;
  }
  
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
  
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
  
  getTimeUntilNextToken(): number {
    if (this.tokens >= this.maxTokens) return 0;
    return (1 / this.refillRate);
  }
}
```

### 2. Monitor Integration

#### Base Monitor Adapter (`src/grpc/monitor-adapter.ts`)

```typescript
import { ConnectionPool } from './connection-pool';

export abstract class MonitorAdapter {
  protected pool: ConnectionPool;
  protected monitorId: string;
  private client?: Client;
  private reconnectAttempts: number = 0;
  
  constructor(pool: ConnectionPool, monitorId: string) {
    this.pool = pool;
    this.monitorId = monitorId;
  }
  
  protected async getClient(): Promise<Client> {
    try {
      if (!this.client) {
        this.client = await this.pool.getConnection(this.monitorId);
        this.reconnectAttempts = 0;
      }
      return this.client;
    } catch (error) {
      console.error(`[${this.monitorId}] Connection error:`, error);
      this.client = undefined;
      
      // Exponential backoff for reconnection
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      this.reconnectAttempts++;
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return this.getClient(); // Retry
    }
  }
  
  async stop(): Promise<void> {
    if (this.client) {
      this.pool.releaseConnection(this.monitorId);
      this.client = undefined;
    }
  }
}
```

#### Updated Monitor Example (`src/monitors/pumpfun-price-monitor-pooled.ts`)

```typescript
import { MonitorAdapter } from '../grpc/monitor-adapter';

class PumpfunPriceMonitor extends MonitorAdapter {
  constructor(pool: ConnectionPool) {
    super(pool, 'pumpfun-price-monitor');
  }
  
  async start(): Promise<void> {
    const client = await this.getClient();
    
    const stream = await client.subscribe({
      accounts: {},
      slots: {},
      transactions: {
        pumpfun: {
          accountInclude: [],
          accountExclude: [],
          accountRequired: []
        }
      },
      transactionsStatus: {},
      entry: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      ping: undefined
    });
    
    stream.on("data", (data) => {
      // Existing processing logic
      this.processTransaction(data);
    });
    
    stream.on("error", (error) => {
      console.error("Stream error:", error);
      this.client = undefined; // Force reconnection
    });
  }
  
  private processTransaction(data: any): void {
    // Existing transaction processing
  }
}
```

### 3. Configuration

#### Environment Variables (`.env`)

```bash
# gRPC Pool Configuration
GRPC_POOL_MAX_CONNECTIONS=15
GRPC_POOL_CONNECTION_TTL=300000  # 5 minutes
GRPC_POOL_HEALTH_CHECK_INTERVAL=30000  # 30 seconds

# Existing config
GRPC_URL=your_grpc_endpoint
X_TOKEN=your_token
```

#### Pool Initialization (`src/grpc/index.ts`)

```typescript
import { ConnectionPool } from './connection-pool';
import { config } from '../config';

// Singleton pool instance
export const grpcPool = new ConnectionPool({
  grpcUrl: config.GRPC_URL,
  token: config.X_TOKEN,
  maxConnections: parseInt(process.env.GRPC_POOL_MAX_CONNECTIONS || '15'),
  connectionTTL: parseInt(process.env.GRPC_POOL_CONNECTION_TTL || '300000'),
  healthCheckInterval: parseInt(process.env.GRPC_POOL_HEALTH_CHECK_INTERVAL || '30000')
});

// Simple monitoring endpoint
export function getPoolStats() {
  return grpcPool.getStats();
}
```

### 4. Monitoring & Logging

#### Simple Console Logger (`src/grpc/pool-logger.ts`)

```typescript
export class PoolLogger {
  private intervalId?: NodeJS.Timer;
  
  constructor(private pool: ConnectionPool) {}
  
  start(intervalMs: number = 10000): void {
    this.intervalId = setInterval(() => {
      const stats = this.pool.getStats();
      console.log('\n=== gRPC Pool Status ===');
      console.log(`Connections: ${stats.healthy}/${stats.total} healthy`);
      console.log(`Rate Limit: ${stats.rateLimitRemaining}/60 tokens available`);
      console.log('Monitor Connections:');
      
      stats.monitorConnections.forEach((count, monitor) => {
        console.log(`  - ${monitor}: ${count} connection(s)`);
      });
      console.log('=======================\n');
    }, intervalMs);
  }
  
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }
}
```

#### API Endpoint (`src/api/grpc-pool-api.ts`)

```typescript
import { Router } from 'express';
import { grpcPool } from '../grpc';

const router = Router();

router.get('/api/grpc-pool/stats', (req, res) => {
  const stats = grpcPool.getStats();
  res.json({
    success: true,
    data: stats,
    timestamp: new Date()
  });
});

router.get('/api/grpc-pool/health', (req, res) => {
  const stats = grpcPool.getStats();
  const isHealthy = stats.healthy > 0 && stats.rateLimitRemaining > 10;
  
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'degraded',
    connections: stats.healthy,
    rateLimit: stats.rateLimitRemaining
  });
});

export default router;
```

### 5. Migration Plan

#### Step 1: Create Pool Infrastructure

1. Create new directory: `src/grpc/`
2. Implement core classes:
   - `connection-pool.ts`
   - `rate-limiter.ts`
   - `monitor-adapter.ts`
   - `pool-logger.ts`
   - `index.ts`

#### Step 2: Create Test Monitor

1. Copy one monitor (e.g., graduation monitor) as test
2. Refactor to use `MonitorAdapter`
3. Test thoroughly in isolation

#### Step 3: Gradual Migration

```typescript
// Migration script example
// src/scripts/test-pool-migration.ts

import { grpcPool } from '../grpc';
import { GraduationMonitor } from '../monitors/graduation-monitor-pooled';

async function testMigration() {
  console.log('Starting pool test...');
  
  const monitor = new GraduationMonitor(grpcPool);
  
  // Run for 5 minutes
  await monitor.start();
  
  // Log stats every 30 seconds
  const logger = new PoolLogger(grpcPool);
  logger.start(30000);
  
  // Stop after 5 minutes
  setTimeout(async () => {
    await monitor.stop();
    logger.stop();
    console.log('Test completed');
    process.exit(0);
  }, 5 * 60 * 1000);
}

testMigration().catch(console.error);
```

#### Step 4: Update All Monitors

For each monitor:
1. Create pooled version extending `MonitorAdapter`
2. Test individually
3. Update startup scripts to use pooled version
4. Remove old direct connection code

#### Step 5: Add Dashboard Integration

```typescript
// Update dashboard API to include pool stats
// src/api/dashboard-api.ts

import { getPoolStats } from '../grpc';

// Add to existing metrics endpoint
app.get('/api/dashboard/metrics', async (req, res) => {
  const metrics = await getExistingMetrics();
  const poolStats = getPoolStats();
  
  res.json({
    ...metrics,
    grpcPool: {
      connections: poolStats.total,
      healthy: poolStats.healthy,
      rateLimit: poolStats.rateLimitRemaining,
      monitors: Object.fromEntries(poolStats.monitorConnections)
    }
  });
});
```

## Testing Strategy

### Unit Tests

```typescript
// src/grpc/__tests__/rate-limiter.test.ts
describe('RateLimiter', () => {
  it('should enforce token limit', async () => {
    const limiter = new RateLimiter(5, 1000);
    
    // Should allow 5 acquisitions
    for (let i = 0; i < 5; i++) {
      expect(await limiter.tryAcquire()).toBe(true);
    }
    
    // 6th should fail
    expect(await limiter.tryAcquire()).toBe(false);
  });
  
  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter(5, 1000);
    
    // Use all tokens
    for (let i = 0; i < 5; i++) {
      await limiter.tryAcquire();
    }
    
    // Wait for refill
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Should have ~1 token refilled
    expect(await limiter.tryAcquire()).toBe(true);
  });
});
```

### Integration Tests

```typescript
// src/grpc/__tests__/connection-pool.integration.test.ts
describe('ConnectionPool Integration', () => {
  let pool: ConnectionPool;
  
  beforeAll(() => {
    pool = new ConnectionPool({
      grpcUrl: process.env.TEST_GRPC_URL!,
      token: process.env.TEST_TOKEN!,
      maxConnections: 3,
      connectionTTL: 60000,
      healthCheckInterval: 5000
    });
  });
  
  it('should handle multiple monitors', async () => {
    const conn1 = await pool.getConnection('monitor1');
    const conn2 = await pool.getConnection('monitor2');
    const conn3 = await pool.getConnection('monitor3');
    
    expect(conn1).toBeDefined();
    expect(conn2).toBeDefined();
    expect(conn3).toBeDefined();
    
    const stats = pool.getStats();
    expect(stats.total).toBe(3);
  });
});
```

## Deployment Checklist

1. **Pre-deployment**
   - [ ] All unit tests passing
   - [ ] Integration tests with test gRPC endpoint
   - [ ] Load test with simulated 7 monitors
   - [ ] Document rollback procedure

2. **Deployment Steps**
   - [ ] Deploy pool infrastructure (no monitors using it yet)
   - [ ] Deploy and test single monitor migration
   - [ ] Monitor for 24 hours
   - [ ] Migrate remaining monitors one by one
   - [ ] Remove old connection code

3. **Post-deployment**
   - [ ] Monitor rate limit usage
   - [ ] Check connection stability
   - [ ] Verify all monitors functioning
   - [ ] Document any issues found

## Success Metrics

- Zero rate limit violations
- All 7 monitors running stable for 24+ hours
- Connection reuse working (fewer than 7 total connections)
- Automatic recovery from connection failures
- Pool stats API returning accurate data

## Next Phase Preview

Phase 2 will add:
- Stream multiplexing (multiple monitors per connection)
- Advanced monitoring dashboard
- Connection pooling by frequency groups
- Metrics persistence
- Performance optimizations