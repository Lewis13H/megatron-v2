# gRPC Connection Pool Design

## Overview

Design for a robust gRPC connection pool service that manages connections to the Yellowstone gRPC endpoint while respecting the 60 connections per 60 seconds rate limit.

## Requirements

### Constraints
- **Rate Limit**: 60 connections per 60 seconds
- **Current Scale**: 7 monitors running concurrently
- **Future Scale**: ~15 monitors expected
- **Stream Types**: Transactions, Accounts, Blocks
- **Reliability**: Auto-reconnection on failure
- **Resource Efficiency**: Reuse connections where possible

### Current Monitors (7)
1. Pump.fun Token Mint Monitor
2. Pump.fun Price Monitor
3. Pump.fun Account Monitor
4. Pump.fun Transaction Monitor
5. Raydium Launchpad Mint Monitor
6. Raydium Launchpad Account Monitor
7. Graduation Monitor

### Goals
- Support 15+ monitors without hitting rate limits
- Maximize connection reuse through multiplexing
- Provide fair access to all monitors
- Handle failures gracefully
- Simple API for monitor integration

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────┐
│                    Monitor Layer                         │
├──────────┬──────────┬──────────┬──────────┬────────────┤
│ PumpFun  │ PumpFun  │ Raydium  │ Raydium  │ Graduation │
│  Mint    │  Price   │  Mint    │ Account  │  Monitor   │
└──────┬───┴──────┬───┴──────┬───┴──────┬───┴──────┬─────┘
       │          │          │          │          │
       └──────────┴──────────┼──────────┴──────────┘
                            │
                    ┌───────▼────────┐
                    │ Connection Pool │
                    │    Manager      │
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │  Rate Limiter  │
                    │ (Token Bucket) │
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │ gRPC Clients   │
                    │  (Yellowstone) │
                    └────────────────┘
```

### Connection Pool Strategy

#### 1. Connection Allocation
- **Max Pool Size**: 40 connections (safety margin under 60)
- **Connection Strategy**:
  - With 7 monitors: ~5-6 connections per monitor possible
  - With 15 monitors: ~2-3 connections per monitor possible
  - Solution: Heavy multiplexing with up to 10-15 streams per connection
- **Dynamic Allocation**: Connections allocated based on actual usage patterns

#### 2. Connection Lifecycle
```
[Created] → [Active] → [Idle] → [Expired/Failed] → [Removed]
    ↑                     ↓
    └─────[Recycled]──────┘
```

- **TTL**: 5 minutes per connection
- **Idle Timeout**: 1 minute without streams
- **Health Check**: Every 30 seconds

#### 3. Rate Limiting Implementation
- **Token Bucket Algorithm**:
  - Capacity: 60 tokens
  - Refill Rate: 1 token per second
  - Burst Capacity: 60 (full minute's worth)
- **Connection Request Queue**: FIFO with timeout
- **Priority System**: Critical monitors get priority

### Connection Sharing Strategy

#### Stream Multiplexing
- **Current (7 monitors)**: 5-10 streams per connection
- **Future (15 monitors)**: 10-15 streams per connection
- **Smart Routing**: Group similar subscription types
- **Load Balancing**: Distribute streams evenly

#### Scaling Strategy
```yaml
Phase 1 (7 monitors - Current):
  - Total Connections: 10-15
  - Streams per Connection: 1-2
  - Headroom for bursts: 25-30 connections

Phase 2 (10-12 monitors):
  - Total Connections: 20-25
  - Streams per Connection: 2-3
  - Begin connection sharing

Phase 3 (15+ monitors):
  - Total Connections: 30-35
  - Streams per Connection: 3-5
  - Aggressive multiplexing
  - Consider sharding strategies
```

#### Connection Pooling Groups
```yaml
High-Frequency Group (Real-time data):
  - Pump.fun Price Monitor
  - Pump.fun Transaction Monitor
  - Future: Other price feeds
  - Allocation: 40% of pool

Medium-Frequency Group (Token events):
  - Pump.fun Mint Monitor
  - Raydium Mint Monitor
  - Graduation Monitor
  - Allocation: 30% of pool

Low-Frequency Group (State monitoring):
  - Pump.fun Account Monitor
  - Raydium Account Monitor
  - Future: Pool state monitors
  - Allocation: 20% of pool

Reserve Pool:
  - Burst capacity
  - New monitor testing
  - Failover connections
  - Allocation: 10% of pool
```

### Error Handling

#### Connection Failures
1. Mark connection as failed
2. Remove from pool
3. Redistribute active streams to healthy connections
4. Create replacement connection (respecting rate limit)

#### Stream Failures
1. Log error with context
2. Attempt reconnection with exponential backoff
3. Alert if repeated failures
4. Fallback to alternate connection

#### Rate Limit Exceeded
1. Queue new connection requests
2. Implement backpressure to monitors
3. Log warnings for capacity planning
4. Consider stream consolidation

## Implementation Details

### API Design

```typescript
interface ConnectionPoolAPI {
  // Get a connection for a specific monitor
  getConnection(monitorId: string, priority?: Priority): Promise<Connection>
  
  // Release a connection back to pool
  releaseConnection(connectionId: string): void
  
  // Report connection health
  reportFailure(connectionId: string, error: Error): void
  
  // Get pool statistics
  getStats(): PoolStats
}

interface PoolStats {
  totalConnections: number
  activeConnections: number
  queuedRequests: number
  rateLimitRemaining: number
  connectionsPerMonitor: Map<string, number>
}
```

### Configuration

```typescript
interface PoolConfig {
  maxConnections: number        // Default: 40
  connectionTTL: number         // Default: 5 minutes
  maxStreamsPerConnection: number // Default: 15
  rateLimitWindow: number       // Default: 60 seconds
  rateLimitMax: number          // Default: 60
  healthCheckInterval: number   // Default: 30 seconds
  
  // Scaling configurations
  monitorGroups: {
    highFrequency: string[]     // Monitor IDs for real-time data
    mediumFrequency: string[]   // Monitor IDs for event data
    lowFrequency: string[]      // Monitor IDs for state data
  }
}
```

### Monitoring & Observability

#### Metrics to Track
- Connection creation rate
- Connection failure rate
- Queue depth and wait times
- Stream distribution
- Rate limit usage
- Connection lifetime

#### Logging
- Connection lifecycle events
- Rate limit warnings
- Error patterns
- Performance metrics

### Dashboard Metrics

#### Real-Time Metrics (Updated Every Second)
```typescript
interface GrpcPoolMetrics {
  // Connection Health
  connections: {
    total: number              // Total connections in pool
    active: number             // Currently streaming
    idle: number               // Open but no streams
    failed: number             // Failed in last 5 min
    creating: number           // Currently being created
  }
  
  // Rate Limit Status
  rateLimit: {
    tokensAvailable: number    // Current tokens (0-60)
    tokensUsed1Min: number     // Used in last minute
    percentUsed: number        // Percentage of limit used
    nextTokenIn: number        // Seconds until next token
    queuedRequests: number     // Waiting for tokens
  }
  
  // Stream Distribution
  streams: {
    total: number              // Total active streams
    perConnection: {           // Distribution histogram
      '1-5': number
      '6-10': number
      '11-15': number
      '15+': number
    }
    byMonitor: Map<string, number>  // Streams per monitor
  }
  
  // Performance
  performance: {
    avgConnectionTime: number   // Avg time to establish (ms)
    avgQueueWaitTime: number    // Avg wait for token (ms)
    connectionUptime: number    // Avg connection lifetime (s)
    reconnectsLastHour: number  // Reconnection count
  }
  
  // Monitor Status
  monitors: {
    total: number              // Total registered monitors
    active: number             // Currently streaming
    waiting: number            // Queued for connection
    failed: number             // Failed to connect
    byGroup: {
      highFrequency: number
      mediumFrequency: number
      lowFrequency: number
    }
  }
}
```

#### Historical Metrics (5-Minute Aggregates)
```typescript
interface GrpcPoolHistoricalMetrics {
  timestamp: Date
  
  // Connection Stats
  connections: {
    created: number            // New connections created
    failed: number             // Connection failures
    recycled: number           // Connections reused
    expired: number            // TTL expirations
  }
  
  // Rate Limit Stats
  rateLimit: {
    maxUsed: number           // Peak usage in period
    avgUsed: number           // Average usage
    violations: number        // Times limit was hit
    queueDepthMax: number     // Max queue depth
  }
  
  // Stream Stats
  streams: {
    created: number           // New streams created
    completed: number         // Streams closed normally
    failed: number            // Stream errors
    avgDuration: number       // Avg stream lifetime (s)
  }
  
  // Health Score (0-100)
  health: {
    score: number             // Overall health score
    factors: {
      connectionStability: number  // Based on failure rate
      rateLimitHeadroom: number   // Available capacity
      streamDistribution: number  // How well balanced
      queuePerformance: number    // Wait time performance
    }
  }
}
```

#### Dashboard Display Components

##### Lightweight Visual Dashboard

###### Compact Status View (Minimal Space)
```
gRPC Pool Status [Live]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Connections: ████████████████░░░░ 25/40 (62%)
Rate Limit:  ██████████████░░░░░░ 35/60 (58%)
Queue:       ░░░░░░░░░░░░░░░░░░░░ 0 waiting

Active Monitors (7/7):
[H] PF-Price●●● PF-Trans●●● 
[M] PF-Mint●● RL-Mint●● Grad● 
[L] PF-Acct● RL-Acct○ 

● = streaming, ○ = idle, × = failed
[H]igh [M]edium [L]ow frequency groups
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

###### ASCII Flow Visualization
```
gRPC Connection Flow (Real-time)
┌─────────────────────────────────────────────────┐
│ Monitors          Pool            Yellowstone   │
│                                                 │
│ PF-Price    ━━━┓                               │
│ PF-Trans    ━━━┫━━━ Conn#1 ════════════════╗  │
│                ┃     (6/15)                 ║  │
│ PF-Mint     ━━━┫━━━ Conn#2 ════════════════╬══│
│ RL-Mint     ━━━┛     (4/15)                 ║  │
│                                             ║  │
│ Graduation  ━━━━━━━ Conn#3 ════════════════╬══│
│                      (1/15)                 ║  │
│ PF-Account  ━━━┓                           ║  │
│ RL-Account  ━━━┫━━━ Conn#4 ════════════════╝  │
│                      (2/15)                    │
│                                                │
│ Rate: ████████████░░░░░░░░ 35/60 tokens        │
└─────────────────────────────────────────────────┘
━ = active stream, ═ = connection, (n/15) = streams/max
```

###### Ultra-Compact Single Line Status
```
gRPC: 25/40 conns | 35/60 rate | 7/7 mons | ✓ healthy
```

###### Terminal-Friendly Live View
```
┌─ gRPC Pool Monitor ─────────────────── 14:32:05 ─┐
│                                                   │
│  Connections     Rate Limit      Active Streams  │
│  ██████▒▒▒▒ 25   ███████▒▒▒ 35   ████████ 42    │
│                                                   │
│  Monitor Status:                                  │
│  • PF-Price    [███] 3 streams  ↑512 msg/s      │
│  • PF-Trans    [███] 3 streams  ↑387 msg/s      │
│  • PF-Mint     [██ ] 2 streams  ↑12 msg/s       │
│  • RL-Mint     [██ ] 2 streams  ↑8 msg/s        │
│  • Graduation  [█  ] 1 stream   ↑2 msg/s        │
│  • PF-Account  [█  ] 1 stream   ↑156 msg/s      │
│  • RL-Account  [   ] 0 streams  idle            │
│                                                   │
│  Health: ████████████████████▒▒ 94%             │
│  Queue: Empty | Next Token: 1s | Uptime: 2h34m  │
└───────────────────────────────────────────────────┘
```

###### Sparkline View (Last 5 Minutes)
```
Connections: ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁ (25)
Rate Limit:  ▃▄▅▆▇█▇▆▅▄▃▂▁▂▃ (35)
Queue Depth: ▁▁▁▂▁▁▁▁▁▁▁▁▁▁▁ (0)
Failures:    ▁▁▁▁▁█▁▁▁▁▁▁▁▁▁ (1)
```

##### 1. Connection Pool Status (Top Bar)
```
┌─────────────────────────────────────────────────────────┐
│ Connections: 25/40 (62.5%)  │  Rate Limit: 35/60 (58%)  │
│ Active: 22  Idle: 3  Failed: 2  │  Queue: 0  Next: 1s  │
└─────────────────────────────────────────────────────────┘
```

##### 2. Monitor Grid View
```
┌─────────────────────┬─────────────────────┬─────────────────────┐
│ High Frequency (4)  │ Medium Frequency (2)│ Low Frequency (1)   │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ PF Price    [●] 3c  │ PF Mint     [●] 2c  │ PF Account  [●] 1c  │
│ PF Trans    [●] 3c  │ RL Mint     [●] 2c  │ RL Account  [○] 0c  │
│ Future 1    [○] 0c  │ Graduation  [●] 1c  │ Future 3    [○] 0c  │
│ Future 2    [○] 0c  │                     │                     │
└─────────────────────┴─────────────────────┴─────────────────────┘
[●] = Active, [○] = Idle, c = connections
```

##### 3. Performance Metrics (Line Charts)
- Rate Limit Usage (%) - Last 30 minutes
- Connection Count - Last 30 minutes
- Queue Depth - Last 30 minutes
- Failure Rate - Last 30 minutes

##### 4. Health Indicators
```
Overall Health: 94/100 ████████████████████░
├─ Connection Stability: 98% (2 failures/hour)
├─ Rate Limit Headroom: 42% (25/60 avg)
├─ Stream Balance: 88% (well distributed)
└─ Queue Performance: 96% (avg wait: 120ms)
```

##### 5. Alerts & Warnings
```
⚠️ Rate limit approaching 80% - consider stream consolidation
⚠️ Monitor "PF Price" has 5 reconnects in last hour
✓ All monitors connected successfully
```

#### API Endpoints for Dashboard
```typescript
// Real-time metrics (WebSocket or polling)
GET /api/grpc-pool/metrics

// Historical metrics
GET /api/grpc-pool/metrics/history?period=30m

// Monitor-specific metrics
GET /api/grpc-pool/metrics/monitor/:monitorId

// Health check
GET /api/grpc-pool/health
```

#### Implementation Notes
1. Use TimescaleDB for storing historical metrics
2. Update real-time metrics via WebSocket for live dashboard
3. Calculate health scores using weighted factors
4. Implement alert thresholds (80% rate limit, >5 failures/hour)
5. Provide CSV export for historical analysis

## Integration Guide

### For New Monitors

1. Register monitor with pool on startup
2. Request connection when needed
3. Handle connection failures gracefully
4. Release connection when done
5. Implement reconnection logic

### Migration Path

1. Create pool service module
2. Update one monitor as pilot
3. Monitor performance and stability
4. Gradually migrate other monitors
5. Remove direct client creation

## Benefits

1. **Rate Limit Compliance**: Automatic enforcement
2. **Resource Efficiency**: Connection reuse
3. **Reliability**: Centralized error handling
4. **Scalability**: Easy to add new monitors
5. **Observability**: Unified metrics and logging
6. **Fairness**: No monitor can monopolize connections

## Scaling Considerations

### From 7 to 15 Monitors

#### Connection Efficiency
- **7 monitors**: Can afford dedicated connections
- **15 monitors**: Must share connections efficiently
- **Key**: Implement multiplexing early, even with 7 monitors

#### Resource Planning
```
Current (7 monitors):
- Avg streams/monitor: 1-2
- Total streams: 7-14
- Connections needed: 10-15
- Utilization: 25-38% of rate limit

Target (15 monitors):
- Avg streams/monitor: 2-3
- Total streams: 30-45
- Connections needed: 30-35
- Utilization: 50-58% of rate limit
```

### Trade-offs
- **Complexity**: Connection sharing vs dedicated connections
- **Latency**: Potential queueing during high load
- **Reliability**: Single connection failure affects multiple monitors
- **Efficiency**: Better resource utilization

### Future Enhancements
- **Auto-scaling**: Dynamic adjustment based on monitor count
- **Priority Queues**: Different SLAs for different monitor types
- **Circuit Breakers**: Prevent cascade failures
- **Metrics-based Routing**: Route based on connection performance
- **Horizontal Scaling**: Multiple gRPC endpoints if available