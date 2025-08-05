# gRPC Connection Pool - Phase 2: Enhanced Multiplexing & Monitoring

## Overview

Phase 2 builds upon the Phase 1 foundation to introduce stream multiplexing, advanced monitoring, and connection grouping. This phase prepares the system for scaling from 7 to 15+ monitors while maintaining efficiency and reliability.

## Goals

- Implement stream multiplexing (multiple monitors per connection)
- Add connection grouping by frequency (High/Medium/Low)
- Create comprehensive monitoring dashboard
- Implement metrics persistence with TimescaleDB
- Add performance optimizations and caching
- Support 10-12 monitors efficiently

## Architecture Enhancement

### Enhanced Pool Design

```
┌─────────────────────────────────────────────┐
│              Monitor Layer                   │
├──────┬──────┬──────┬──────┬──────┬─────────┤
│ High │ Med  │ Low  │ High │ Med  │   ...   │
└──┬───┴──┬───┴──┬───┴──┬───┴──┬───┴─────────┘
   │      │      │      │      │
   └──────┴──────┼──────┴──────┘
                 │
         ┌───────▼────────┐
         │ Stream Router  │ ← New: Routes monitors to connections
         └───────┬────────┘
                 │
         ┌───────▼────────┐
         │ Connection     │
         │ Groups (H/M/L) │ ← New: Grouped by frequency
         └───────┬────────┘
                 │
         ┌───────▼────────┐
         │ Multiplexed    │ ← New: Multiple streams per connection
         │ Connections    │
         └───────┬────────┘
                 │
         ┌───────▼────────┐
         │ Metrics        │ ← New: Real-time metrics collection
         │ Collector      │
         └────────────────┘
```

## Implementation Details

### 1. Stream Multiplexing

#### Enhanced Connection Pool (`src/grpc/connection-pool-v2.ts`)

```typescript
import { Client, SubscribeRequest } from '@triton-one/yellowstone-grpc';
import { Readable } from 'stream';

interface MultiplexedConnection extends PooledConnection {
  streams: Map<string, StreamInfo>;
  maxStreams: number;
  connectionGroup: 'high' | 'medium' | 'low';
}

interface StreamInfo {
  monitorId: string;
  stream: Readable;
  subscriptionRequest: SubscribeRequest;
  createdAt: Date;
  messageCount: number;
}

class EnhancedConnectionPool extends ConnectionPool {
  private streamRouter: StreamRouter;
  private metricsCollector: MetricsCollector;
  private connectionGroups: Map<string, MultiplexedConnection[]>;
  
  constructor(config: EnhancedPoolConfig) {
    super(config);
    this.streamRouter = new StreamRouter(config.monitorGroups);
    this.metricsCollector = new MetricsCollector();
    this.initializeConnectionGroups();
  }
  
  async getStream(
    monitorId: string, 
    request: SubscribeRequest
  ): Promise<Readable> {
    const group = this.streamRouter.getMonitorGroup(monitorId);
    const connection = await this.getOrCreateGroupConnection(group);
    
    // Check if we can multiplex on existing connection
    if (connection.streams.size < connection.maxStreams) {
      return await this.createMultiplexedStream(connection, monitorId, request);
    }
    
    // Need a new connection in the group
    const newConnection = await this.createGroupConnection(group);
    return await this.createMultiplexedStream(newConnection, monitorId, request);
  }
  
  private async createMultiplexedStream(
    connection: MultiplexedConnection,
    monitorId: string,
    request: SubscribeRequest
  ): Promise<Readable> {
    // Merge subscription requests for this connection
    const mergedRequest = this.mergeSubscriptionRequests(
      connection.streams,
      request
    );
    
    // Create new stream with merged request
    const stream = await connection.client.subscribe(mergedRequest);
    
    // Create filtered stream for this monitor
    const filteredStream = new MonitorFilterStream(monitorId, request);
    
    // Pipe data to all monitor streams
    stream.on('data', (data) => {
      this.routeDataToMonitors(connection, data);
      this.metricsCollector.recordMessage(connection.id, monitorId);
    });
    
    // Store stream info
    const streamInfo: StreamInfo = {
      monitorId,
      stream: filteredStream,
      subscriptionRequest: request,
      createdAt: new Date(),
      messageCount: 0
    };
    
    connection.streams.set(monitorId, streamInfo);
    
    console.log(`[Pool] Added stream for ${monitorId} to connection ${connection.id} (${connection.streams.size}/${connection.maxStreams})`);
    
    return filteredStream;
  }
  
  private mergeSubscriptionRequests(
    existingStreams: Map<string, StreamInfo>,
    newRequest: SubscribeRequest
  ): SubscribeRequest {
    const merged: SubscribeRequest = {
      accounts: {},
      transactions: {},
      slots: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      ping: undefined
    };
    
    // Merge all existing requests
    existingStreams.forEach((streamInfo) => {
      this.mergeIntoRequest(merged, streamInfo.subscriptionRequest);
    });
    
    // Add new request
    this.mergeIntoRequest(merged, newRequest);
    
    return merged;
  }
  
  private routeDataToMonitors(
    connection: MultiplexedConnection,
    data: any
  ): void {
    connection.streams.forEach((streamInfo, monitorId) => {
      if (this.dataMatchesFilter(data, streamInfo.subscriptionRequest)) {
        streamInfo.stream.push(data);
        streamInfo.messageCount++;
      }
    });
  }
}

// Custom stream that filters data for specific monitor
class MonitorFilterStream extends Readable {
  constructor(
    private monitorId: string,
    private filter: SubscribeRequest
  ) {
    super({ objectMode: true });
  }
  
  _read() {
    // Data is pushed by the connection pool
  }
}
```

#### Stream Router (`src/grpc/stream-router.ts`)

```typescript
interface MonitorGroupConfig {
  highFrequency: string[];
  mediumFrequency: string[];
  lowFrequency: string[];
}

class StreamRouter {
  private groupMap: Map<string, 'high' | 'medium' | 'low'>;
  
  constructor(config: MonitorGroupConfig) {
    this.groupMap = new Map();
    
    config.highFrequency.forEach(id => this.groupMap.set(id, 'high'));
    config.mediumFrequency.forEach(id => this.groupMap.set(id, 'medium'));
    config.lowFrequency.forEach(id => this.groupMap.set(id, 'low'));
  }
  
  getMonitorGroup(monitorId: string): 'high' | 'medium' | 'low' {
    return this.groupMap.get(monitorId) || 'medium';
  }
  
  getGroupAllocation(): { [key: string]: number } {
    return {
      high: 0.4,    // 40% of connections
      medium: 0.3,  // 30% of connections
      low: 0.2,     // 20% of connections
      reserve: 0.1  // 10% reserve
    };
  }
  
  getMaxStreamsForGroup(group: string): number {
    switch(group) {
      case 'high': return 5;    // Fewer streams for real-time data
      case 'medium': return 10; // Moderate multiplexing
      case 'low': return 15;    // Heavy multiplexing for slow data
      default: return 10;
    }
  }
}
```

### 2. Advanced Monitoring

#### Metrics Collector (`src/grpc/metrics-collector.ts`)

```typescript
interface ConnectionMetrics {
  connectionId: string;
  group: string;
  created: Date;
  streams: number;
  messagesPerSecond: number;
  bytesPerSecond: number;
  errors: number;
  latency: number;
}

interface MonitorMetrics {
  monitorId: string;
  connectionId: string;
  messagesReceived: number;
  bytesReceived: number;
  lastMessageTime: Date;
  averageLatency: number;
  errors: number;
}

class MetricsCollector {
  private connectionMetrics: Map<string, ConnectionMetrics>;
  private monitorMetrics: Map<string, MonitorMetrics>;
  private metricsBuffer: MetricsEvent[];
  private flushInterval: NodeJS.Timer;
  
  constructor() {
    this.connectionMetrics = new Map();
    this.monitorMetrics = new Map();
    this.metricsBuffer = [];
    this.startPeriodicFlush();
  }
  
  recordMessage(connectionId: string, monitorId: string, bytes: number = 0): void {
    // Update connection metrics
    const connMetrics = this.connectionMetrics.get(connectionId);
    if (connMetrics) {
      connMetrics.messagesPerSecond++;
      connMetrics.bytesPerSecond += bytes;
    }
    
    // Update monitor metrics
    const monMetrics = this.monitorMetrics.get(monitorId);
    if (monMetrics) {
      monMetrics.messagesReceived++;
      monMetrics.bytesReceived += bytes;
      monMetrics.lastMessageTime = new Date();
    }
    
    // Buffer for persistence
    this.metricsBuffer.push({
      type: 'message',
      connectionId,
      monitorId,
      timestamp: new Date(),
      bytes
    });
  }
  
  recordError(connectionId: string, monitorId: string, error: Error): void {
    const connMetrics = this.connectionMetrics.get(connectionId);
    if (connMetrics) connMetrics.errors++;
    
    const monMetrics = this.monitorMetrics.get(monitorId);
    if (monMetrics) monMetrics.errors++;
    
    this.metricsBuffer.push({
      type: 'error',
      connectionId,
      monitorId,
      timestamp: new Date(),
      error: error.message
    });
  }
  
  getRealtimeMetrics(): GrpcPoolMetrics {
    const connections = Array.from(this.connectionMetrics.values());
    const monitors = Array.from(this.monitorMetrics.values());
    
    // Calculate aggregates
    const totalStreams = connections.reduce((sum, c) => sum + c.streams, 0);
    const streamDistribution = this.calculateStreamDistribution(connections);
    
    return {
      connections: {
        total: connections.length,
        active: connections.filter(c => c.streams > 0).length,
        idle: connections.filter(c => c.streams === 0).length,
        failed: connections.filter(c => c.errors > 0).length,
        creating: 0 // Updated by pool
      },
      
      rateLimit: {
        tokensAvailable: this.getRateLimitTokens(),
        tokensUsed1Min: this.getTokensUsedLastMinute(),
        percentUsed: (60 - this.getRateLimitTokens()) / 60 * 100,
        nextTokenIn: this.getTimeToNextToken(),
        queuedRequests: this.getQueuedRequests()
      },
      
      streams: {
        total: totalStreams,
        perConnection: streamDistribution,
        byMonitor: new Map(monitors.map(m => [m.monitorId, 1]))
      },
      
      performance: {
        avgConnectionTime: this.getAvgConnectionTime(),
        avgQueueWaitTime: this.getAvgQueueWaitTime(),
        connectionUptime: this.getAvgConnectionUptime(),
        reconnectsLastHour: this.getReconnectsLastHour()
      },
      
      monitors: {
        total: monitors.length,
        active: monitors.filter(m => m.messagesReceived > 0).length,
        waiting: 0, // Updated by pool
        failed: monitors.filter(m => m.errors > 0).length,
        byGroup: this.getMonitorsByGroup()
      }
    };
  }
  
  private startPeriodicFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flushMetrics();
      this.resetCounters();
    }, 1000); // Flush every second
  }
  
  private async flushMetrics(): Promise<void> {
    if (this.metricsBuffer.length === 0) return;
    
    try {
      // Send to TimescaleDB
      await persistMetrics(this.metricsBuffer);
      this.metricsBuffer = [];
    } catch (error) {
      console.error('[Metrics] Failed to persist metrics:', error);
    }
  }
}
```

#### Metrics Persistence (`src/grpc/metrics-persistence.ts`)

```typescript
import { monitorService } from '../database';

interface MetricsEvent {
  type: 'message' | 'error' | 'connection' | 'stream';
  connectionId: string;
  monitorId?: string;
  timestamp: Date;
  [key: string]: any;
}

async function persistMetrics(events: MetricsEvent[]): Promise<void> {
  const client = await monitorService.getClient();
  
  try {
    // Batch insert metrics
    const values = events.map(e => [
      e.type,
      e.connectionId,
      e.monitorId,
      e.timestamp,
      JSON.stringify(e)
    ]);
    
    await client.query(`
      INSERT INTO grpc_pool_metrics (type, connection_id, monitor_id, timestamp, data)
      VALUES ${values.map((_, i) => 
        `($${i*5+1}, $${i*5+2}, $${i*5+3}, $${i*5+4}, $${i*5+5})`
      ).join(', ')}
    `, values.flat());
    
  } finally {
    client.release();
  }
}

// Database schema for metrics
const metricsSchema = `
CREATE TABLE IF NOT EXISTS grpc_pool_metrics (
  id SERIAL PRIMARY KEY,
  type VARCHAR(20) NOT NULL,
  connection_id VARCHAR(50) NOT NULL,
  monitor_id VARCHAR(100),
  timestamp TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('grpc_pool_metrics', 'timestamp');

-- Index for fast queries
CREATE INDEX idx_grpc_metrics_connection ON grpc_pool_metrics(connection_id, timestamp DESC);
CREATE INDEX idx_grpc_metrics_monitor ON grpc_pool_metrics(monitor_id, timestamp DESC);

-- Continuous aggregate for 1-minute summaries
CREATE MATERIALIZED VIEW grpc_metrics_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', timestamp) AS minute,
  connection_id,
  monitor_id,
  COUNT(*) FILTER (WHERE type = 'message') as message_count,
  COUNT(*) FILTER (WHERE type = 'error') as error_count,
  AVG((data->>'bytes')::numeric) as avg_bytes,
  MAX((data->>'latency')::numeric) as max_latency
FROM grpc_pool_metrics
GROUP BY minute, connection_id, monitor_id
WITH NO DATA;

-- Refresh policy
SELECT add_continuous_aggregate_policy('grpc_metrics_1m',
  start_offset => INTERVAL '10 minutes',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');
`;
```

### 3. Enhanced Dashboard

#### Dashboard API (`src/api/grpc-pool-api-v2.ts`)

```typescript
import { Router } from 'express';
import { WebSocket } from 'ws';
import { enhancedPool } from '../grpc';

const router = Router();
const wsClients = new Set<WebSocket>();

// Real-time metrics via WebSocket
export function setupWebSocket(wss: WebSocket.Server) {
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    
    // Send initial metrics
    ws.send(JSON.stringify({
      type: 'metrics',
      data: enhancedPool.getMetrics()
    }));
    
    ws.on('close', () => {
      wsClients.delete(ws);
    });
  });
  
  // Broadcast metrics every second
  setInterval(() => {
    const metrics = enhancedPool.getMetrics();
    const message = JSON.stringify({
      type: 'metrics',
      data: metrics,
      timestamp: new Date()
    });
    
    wsClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }, 1000);
}

// Historical metrics
router.get('/api/grpc-pool/metrics/history', async (req, res) => {
  const { period = '30m', group_by = 'connection' } = req.query;
  
  const query = `
    SELECT 
      minute,
      ${group_by === 'monitor' ? 'monitor_id' : 'connection_id'} as group_id,
      SUM(message_count) as messages,
      SUM(error_count) as errors,
      AVG(avg_bytes) as avg_bytes,
      MAX(max_latency) as max_latency
    FROM grpc_metrics_1m
    WHERE minute >= NOW() - INTERVAL '${period}'
    GROUP BY minute, group_id
    ORDER BY minute DESC
  `;
  
  const result = await monitorService.query(query);
  
  res.json({
    success: true,
    data: result.rows,
    period,
    group_by
  });
});

// Connection details
router.get('/api/grpc-pool/connections/:id', async (req, res) => {
  const connection = enhancedPool.getConnection(req.params.id);
  
  if (!connection) {
    return res.status(404).json({ error: 'Connection not found' });
  }
  
  res.json({
    success: true,
    data: {
      id: connection.id,
      group: connection.group,
      streams: Array.from(connection.streams.values()).map(s => ({
        monitorId: s.monitorId,
        messages: s.messageCount,
        created: s.createdAt
      })),
      health: connection.isHealthy,
      uptime: Date.now() - connection.createdAt.getTime()
    }
  });
});

// Force reconnection
router.post('/api/grpc-pool/connections/:id/reconnect', async (req, res) => {
  try {
    await enhancedPool.reconnectConnection(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
```

#### Enhanced Dashboard UI (`dashboard/grpc-pool.html`)

```html
<!DOCTYPE html>
<html>
<head>
  <title>gRPC Pool Monitor</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    .metric-card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 16px;
      margin: 8px;
    }
    
    .connection-bar {
      height: 20px;
      background: linear-gradient(to right, 
        #00ff00 0%, 
        #00ff00 var(--used), 
        #333 var(--used), 
        #333 100%);
      border-radius: 4px;
      position: relative;
    }
    
    .stream-bubble {
      display: inline-block;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--color);
      text-align: center;
      line-height: 40px;
      margin: 4px;
      font-size: 12px;
      color: white;
    }
    
    .monitor-status {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 8px;
    }
  </style>
</head>
<body>
  <div id="app">
    <!-- Connection Overview -->
    <div class="metric-card">
      <h3>Connection Pool Status</h3>
      <div class="connection-bar" style="--used: 62.5%">
        <span>25/40 connections (62.5%)</span>
      </div>
      
      <div class="stats-grid">
        <div>Active: <span id="active-conns">22</span></div>
        <div>Idle: <span id="idle-conns">3</span></div>
        <div>Failed: <span id="failed-conns">0</span></div>
        <div>Creating: <span id="creating-conns">0</span></div>
      </div>
    </div>
    
    <!-- Rate Limit Status -->
    <div class="metric-card">
      <h3>Rate Limit Status</h3>
      <div class="connection-bar" style="--used: 58.3%">
        <span>35/60 tokens used (58.3%)</span>
      </div>
      <div>Next token in: <span id="next-token">1s</span></div>
      <div>Queue depth: <span id="queue-depth">0</span></div>
    </div>
    
    <!-- Connection Groups -->
    <div class="metric-card">
      <h3>Connection Groups</h3>
      <div class="connection-groups">
        <div class="group">
          <h4>High Frequency (40%)</h4>
          <div id="high-freq-streams"></div>
        </div>
        <div class="group">
          <h4>Medium Frequency (30%)</h4>
          <div id="med-freq-streams"></div>
        </div>
        <div class="group">
          <h4>Low Frequency (20%)</h4>
          <div id="low-freq-streams"></div>
        </div>
      </div>
    </div>
    
    <!-- Monitor Status Grid -->
    <div class="metric-card">
      <h3>Monitor Status</h3>
      <div class="monitor-status" id="monitor-grid"></div>
    </div>
    
    <!-- Performance Charts -->
    <div class="metric-card">
      <h3>Performance Metrics</h3>
      <canvas id="performance-chart"></canvas>
    </div>
  </div>
  
  <script>
    const ws = new WebSocket('ws://localhost:3001/ws');
    
    ws.onmessage = (event) => {
      const { type, data } = JSON.parse(event.data);
      if (type === 'metrics') {
        updateDashboard(data);
      }
    };
    
    function updateDashboard(metrics) {
      // Update connection stats
      document.getElementById('active-conns').textContent = metrics.connections.active;
      document.getElementById('idle-conns').textContent = metrics.connections.idle;
      document.getElementById('failed-conns').textContent = metrics.connections.failed;
      
      // Update rate limit
      const rateLimitBar = document.querySelector('.connection-bar:nth-of-type(2)');
      rateLimitBar.style.setProperty('--used', `${metrics.rateLimit.percentUsed}%`);
      
      // Update monitor grid
      updateMonitorGrid(metrics.monitors);
      
      // Update connection groups
      updateConnectionGroups(metrics.streams);
    }
    
    function updateMonitorGrid(monitors) {
      const grid = document.getElementById('monitor-grid');
      grid.innerHTML = '';
      
      monitors.forEach(monitor => {
        const card = document.createElement('div');
        card.className = 'monitor-card';
        card.innerHTML = `
          <h4>${monitor.id}</h4>
          <div>Status: ${monitor.status}</div>
          <div>Messages: ${monitor.messageCount}/s</div>
          <div>Errors: ${monitor.errors}</div>
        `;
        grid.appendChild(card);
      });
    }
    
    // Initialize performance chart
    const ctx = document.getElementById('performance-chart').getContext('2d');
    const perfChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Messages/sec',
          data: [],
          borderColor: '#00ff00',
          tension: 0.1
        }, {
          label: 'Errors/min',
          data: [],
          borderColor: '#ff0000',
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        scales: {
          x: { display: true },
          y: { beginAtZero: true }
        }
      }
    });
  </script>
</body>
</html>
```

### 4. Performance Optimizations

#### Connection Caching (`src/grpc/connection-cache.ts`)

```typescript
interface CachedConnection {
  connection: MultiplexedConnection;
  lastAccessed: number;
  hitCount: number;
}

class ConnectionCache {
  private cache: Map<string, CachedConnection>;
  private maxSize: number;
  private ttl: number;
  
  constructor(maxSize: number = 50, ttl: number = 300000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.startCleanup();
  }
  
  get(key: string): MultiplexedConnection | undefined {
    const cached = this.cache.get(key);
    if (!cached) return undefined;
    
    // Check TTL
    if (Date.now() - cached.lastAccessed > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }
    
    // Update access time and hit count
    cached.lastAccessed = Date.now();
    cached.hitCount++;
    
    return cached.connection;
  }
  
  set(key: string, connection: MultiplexedConnection): void {
    // Evict LRU if at capacity
    if (this.cache.size >= this.maxSize) {
      const lru = this.findLRU();
      if (lru) this.cache.delete(lru);
    }
    
    this.cache.set(key, {
      connection,
      lastAccessed: Date.now(),
      hitCount: 0
    });
  }
  
  private findLRU(): string | undefined {
    let lruKey: string | undefined;
    let lruTime = Infinity;
    
    this.cache.forEach((value, key) => {
      if (value.lastAccessed < lruTime) {
        lruTime = value.lastAccessed;
        lruKey = key;
      }
    });
    
    return lruKey;
  }
  
  private startCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];
      
      this.cache.forEach((value, key) => {
        if (now - value.lastAccessed > this.ttl) {
          expired.push(key);
        }
      });
      
      expired.forEach(key => this.cache.delete(key));
    }, 60000); // Cleanup every minute
  }
  
  getStats() {
    const totalHits = Array.from(this.cache.values())
      .reduce((sum, c) => sum + c.hitCount, 0);
    
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      totalHits,
      hitRate: totalHits / (totalHits + this.cache.size)
    };
  }
}
```

#### Request Batching (`src/grpc/request-batcher.ts`)

```typescript
interface BatchedRequest {
  monitorId: string;
  request: SubscribeRequest;
  resolve: (stream: Readable) => void;
  reject: (error: Error) => void;
}

class RequestBatcher {
  private batch: BatchedRequest[] = [];
  private batchTimeout?: NodeJS.Timeout;
  private maxBatchSize: number;
  private batchDelayMs: number;
  
  constructor(maxBatchSize: number = 10, batchDelayMs: number = 100) {
    this.maxBatchSize = maxBatchSize;
    this.batchDelayMs = batchDelayMs;
  }
  
  async addRequest(
    monitorId: string,
    request: SubscribeRequest
  ): Promise<Readable> {
    return new Promise((resolve, reject) => {
      this.batch.push({ monitorId, request, resolve, reject });
      
      if (this.batch.length >= this.maxBatchSize) {
        this.processBatch();
      } else if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(() => {
          this.processBatch();
        }, this.batchDelayMs);
      }
    });
  }
  
  private async processBatch(): Promise<void> {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = undefined;
    }
    
    const currentBatch = this.batch;
    this.batch = [];
    
    if (currentBatch.length === 0) return;
    
    try {
      // Group by similar request patterns
      const groups = this.groupSimilarRequests(currentBatch);
      
      // Process each group
      for (const group of groups) {
        await this.processGroup(group);
      }
    } catch (error) {
      // Reject all requests in batch
      currentBatch.forEach(req => req.reject(error as Error));
    }
  }
  
  private groupSimilarRequests(
    requests: BatchedRequest[]
  ): BatchedRequest[][] {
    const groups: Map<string, BatchedRequest[]> = new Map();
    
    requests.forEach(req => {
      const key = this.getRequestSignature(req.request);
      const group = groups.get(key) || [];
      group.push(req);
      groups.set(key, group);
    });
    
    return Array.from(groups.values());
  }
  
  private getRequestSignature(request: SubscribeRequest): string {
    // Create a signature based on subscription type
    const parts = [];
    
    if (request.accounts && Object.keys(request.accounts).length > 0) {
      parts.push('accounts');
    }
    if (request.transactions && Object.keys(request.transactions).length > 0) {
      parts.push('transactions');
    }
    if (request.blocks && Object.keys(request.blocks).length > 0) {
      parts.push('blocks');
    }
    
    return parts.join('-') || 'empty';
  }
}
```

### 5. Migration from Phase 1

#### Migration Script (`src/scripts/migrate-to-phase2.ts`)

```typescript
import { ConnectionPool } from '../grpc/connection-pool';
import { EnhancedConnectionPool } from '../grpc/connection-pool-v2';
import { config } from '../config';

async function migrateToPhase2() {
  console.log('Starting Phase 2 migration...');
  
  // 1. Create enhanced pool with same config
  const enhancedPool = new EnhancedConnectionPool({
    ...config.grpcPool,
    monitorGroups: {
      highFrequency: ['pumpfun-price-monitor', 'pumpfun-transaction-monitor'],
      mediumFrequency: ['pumpfun-mint-monitor', 'raydium-mint-monitor', 'graduation-monitor'],
      lowFrequency: ['pumpfun-account-monitor', 'raydium-account-monitor']
    },
    enableMultiplexing: true,
    enableMetrics: true,
    maxStreamsPerConnection: 10
  });
  
  // 2. Test with one monitor first
  console.log('Testing with graduation monitor...');
  const testMonitor = new GraduationMonitor(enhancedPool);
  await testMonitor.start();
  
  // 3. Monitor for 5 minutes
  console.log('Monitoring for 5 minutes...');
  await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
  
  // 4. Check metrics
  const metrics = enhancedPool.getMetrics();
  console.log('Metrics:', JSON.stringify(metrics, null, 2));
  
  if (metrics.connections.failed > 0) {
    console.error('Failed connections detected, aborting migration');
    process.exit(1);
  }
  
  // 5. Migrate remaining monitors
  console.log('Migrating remaining monitors...');
  // ... migrate each monitor
  
  console.log('Migration complete!');
}

migrateToPhase2().catch(console.error);
```

## Testing Strategy

### Load Testing

```typescript
// src/grpc/__tests__/load-test-phase2.ts
describe('Phase 2 Load Test', () => {
  let pool: EnhancedConnectionPool;
  
  beforeAll(() => {
    pool = new EnhancedConnectionPool(testConfig);
  });
  
  it('should handle 12 monitors with multiplexing', async () => {
    const monitors = [];
    
    // Create 12 mock monitors
    for (let i = 0; i < 12; i++) {
      const monitor = new MockMonitor(pool, `monitor-${i}`);
      monitors.push(monitor);
      await monitor.start();
      
      // Stagger starts to avoid rate limit
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Run for 10 minutes
    await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000));
    
    // Check metrics
    const metrics = pool.getMetrics();
    expect(metrics.connections.total).toBeLessThan(30); // Should multiplex
    expect(metrics.streams.total).toBe(12);
    expect(metrics.rateLimit.violations).toBe(0);
  });
});
```

### Integration Testing

```typescript
// Test stream multiplexing
it('should correctly route multiplexed data', async () => {
  const received1: any[] = [];
  const received2: any[] = [];
  
  const stream1 = await pool.getStream('monitor1', {
    transactions: { 
      pumpfun: { accountInclude: ['account1'] }
    }
  });
  
  const stream2 = await pool.getStream('monitor2', {
    transactions: { 
      pumpfun: { accountInclude: ['account2'] }
    }
  });
  
  stream1.on('data', data => received1.push(data));
  stream2.on('data', data => received2.push(data));
  
  // Wait for data
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Verify each monitor only received its filtered data
  expect(received1.every(d => d.account === 'account1')).toBe(true);
  expect(received2.every(d => d.account === 'account2')).toBe(true);
});
```

## Deployment Plan

### Prerequisites
- Phase 1 running stable for at least 1 week
- Database schema updated for metrics tables
- Dashboard infrastructure ready
- Load testing completed successfully

### Rollout Steps

1. **Week 1: Infrastructure**
   - Deploy enhanced pool code (inactive)
   - Set up metrics database tables
   - Deploy dashboard UI
   - Enable metrics collection only

2. **Week 2: Pilot Testing**
   - Migrate 2 low-frequency monitors
   - Monitor multiplexing behavior
   - Tune configuration based on metrics
   - Fix any issues found

3. **Week 3: Gradual Migration**
   - Migrate medium-frequency monitors
   - Verify connection sharing working
   - Check dashboard accuracy
   - Performance optimization

4. **Week 4: Full Migration**
   - Migrate high-frequency monitors
   - Remove Phase 1 code
   - Document final configuration
   - Training on dashboard usage

## Success Metrics

- Stream multiplexing working with <1% data loss
- Connection count reduced by 40%+ through sharing
- Dashboard showing real-time metrics accurately
- Zero rate limit violations during migration
- 99.9% uptime maintained
- Response time <100ms for stream creation

## Risk Mitigation

1. **Multiplexing Failures**
   - Fallback to dedicated connections
   - Monitor data integrity closely
   - Implement checksums if needed

2. **Performance Degradation**
   - Connection cache to reduce overhead
   - Request batching for efficiency
   - Monitor CPU/memory usage

3. **Dashboard Overload**
   - Rate limit dashboard queries
   - Implement caching layer
   - Use aggregated metrics