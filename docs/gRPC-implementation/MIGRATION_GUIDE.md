# gRPC Connection Pool Migration Guide

## Overview

This guide explains how to migrate existing monitors to use the new gRPC connection pool, which manages rate limiting and connection lifecycle automatically.

## Benefits of Migration

- **Automatic rate limit protection** - No more 429 errors
- **Connection reuse** - More efficient resource usage
- **Automatic reconnection** - Built-in exponential backoff
- **Centralized monitoring** - Pool statistics and health checks
- **Simplified code** - No manual connection management

## Migration Steps

### 1. Update Monitor Class

Change your monitor to extend `MonitorAdapter` instead of managing connections directly:

```typescript
// Before:
class MyMonitor {
  private client: Client;
  
  constructor() {
    this.client = new Client(grpcUrl, token);
  }
}

// After:
import { MonitorAdapter } from '../grpc/monitor-adapter';
import { grpcPool } from '../grpc';

class MyMonitor extends MonitorAdapter {
  constructor() {
    super(grpcPool, 'my-monitor-id');
  }
}
```

### 2. Update Connection Logic

Replace direct client creation with pool requests:

```typescript
// Before:
async start() {
  const stream = await this.client.subscribe(request);
  // ...
}

// After:
async start() {
  const client = await this.getClient(); // Gets from pool
  const stream = await client.subscribe(request);
  // ...
}
```

### 3. Update Error Handling

Use the base class error handler for automatic reconnection:

```typescript
// Before:
stream.on('error', (error) => {
  console.error('Error:', error);
  // Manual reconnection logic
});

// After:
stream.on('error', (error) => {
  this.handleConnectionError(error); // Automatic reconnection
});
```

### 4. Add Cleanup

Implement proper cleanup in stop method:

```typescript
async stop() {
  // Your cleanup logic
  await super.stop(); // Releases connection back to pool
}
```

## Complete Example

See `src/monitors/examples/graduation-monitor-pooled.ts` for a complete example of a migrated monitor.

## Testing Your Migration

1. **Test script**: Run the pool test to verify functionality:
   ```bash
   npx ts-node src/scripts/test-grpc-pool.ts
   ```

2. **Monitor pool stats**: Start the pool logger to monitor connections:
   ```typescript
   import { poolLogger } from '../grpc';
   poolLogger.start(10000); // Log every 10 seconds
   ```

3. **API endpoints**: Check pool health via API:
   ```
   GET http://localhost:3001/api/grpc-pool/stats
   GET http://localhost:3001/api/grpc-pool/health
   GET http://localhost:3001/api/grpc-pool/report
   ```

## Configuration

Set these environment variables in your `.env` file:

```env
# Connection pool settings (optional, defaults shown)
GRPC_POOL_MAX_CONNECTIONS=15        # Max concurrent connections
GRPC_POOL_CONNECTION_TTL=300000     # Connection lifetime (5 min)
GRPC_POOL_HEALTH_CHECK_INTERVAL=30000  # Health check interval (30s)
```

## Migration Checklist

For each monitor:

- [ ] Extend `MonitorAdapter` base class
- [ ] Replace direct client creation with `getClient()`
- [ ] Update error handlers to use `handleConnectionError()`
- [ ] Add proper cleanup in `stop()` method
- [ ] Test monitor individually
- [ ] Verify in pool statistics
- [ ] Remove old connection management code

## Rollback Plan

If issues occur, you can quickly rollback by:

1. Keep original monitor files with `-old` suffix
2. Switch back in your startup scripts
3. The pool and original monitors can run side-by-side

## Common Issues

### Issue: "Rate limit exceeded"
**Solution**: This is working as intended - the pool is protecting you from hitting the API rate limit. Wait a moment and it will retry automatically.

### Issue: "No connections available"
**Solution**: You have too many monitors for the connection limit. Either:
- Increase `GRPC_POOL_MAX_CONNECTIONS` (max 40 recommended)
- Reduce the number of concurrent monitors
- Implement connection sharing (Phase 2)

### Issue: Monitor not reconnecting
**Solution**: Make sure you're calling `this.handleConnectionError(error)` in your error handlers and not throwing unhandled errors.

## Monitoring Dashboard

A simple dashboard to monitor the pool:

```typescript
// src/scripts/monitor-pool.ts
import { poolLogger, getPoolStats } from '../grpc';

// Start continuous logging
poolLogger.start(5000);

// Or get one-time stats
setInterval(() => {
  const stats = getPoolStats();
  console.clear();
  console.log('gRPC Pool Dashboard');
  console.log('==================');
  console.log(`Connections: ${stats.healthy}/${stats.total}`);
  console.log(`Rate Limit: ${stats.rateLimitRemaining}/60`);
  console.log(`Monitors: ${stats.monitorConnections.size}`);
}, 1000);
```

## Support

- Check logs for `[Pool]` prefixed messages
- Use `getPoolReport()` for detailed diagnostics
- Monitor `/api/grpc-pool/health` endpoint

## Next Steps

Once all monitors are migrated and stable:

1. Remove old direct connection code
2. Consider enabling advanced features (Phase 2)
3. Set up monitoring alerts based on pool metrics