# Raydium Launchpad Mint Monitor - Migration to Connection Pool

## Migration Summary

Successfully migrated the Raydium Launchpad new token mint monitor to use the gRPC connection pool. The monitor now benefits from automatic rate limiting protection, connection reuse, and centralized monitoring.

## Files Created/Modified

### 1. New Pooled Monitor
**File**: `src/monitors/raydium-launchpad/raydium-launchpad-monitor-new-token-mint-pooled.ts`

Key changes from original:
- Extends `MonitorAdapter` base class
- Uses `getClient()` from pool instead of direct connection
- Proper error handling with automatic reconnection
- Clean shutdown with `stop()` method

### 2. Test Script
**File**: `src/scripts/test-rl-mint-monitor-pooled.ts`

Features:
- Tests connection pooling
- Verifies subscription setup
- Shows pool statistics
- 30-second test run

### 3. Startup Script
**File**: `src/scripts/start-rl-mint-monitor-pooled.ts`

Features:
- Production-ready startup
- Health monitoring every minute
- Graceful shutdown handling
- Pool statistics logging
- Error recovery

### 4. Package.json Update
Added new npm script:
```json
"rlmonitor:mint:pooled": "npx tsx src/scripts/start-rl-mint-monitor-pooled.ts"
```

## Usage

### Running the Pooled Version

```bash
# Using npm script (recommended)
npm run rlmonitor:mint:pooled

# Or directly
npx tsx src/scripts/start-rl-mint-monitor-pooled.ts
```

### Running the Original Version (still available)

```bash
npm run rlmonitor:mint
```

## Migration Pattern Applied

The migration followed the standard pattern:

1. **Class Structure**:
   ```typescript
   class RaydiumLaunchpadMintMonitorPooled extends MonitorAdapter {
     constructor() {
       super(grpcPool, 'raydium-launchpad-mint-monitor');
     }
   }
   ```

2. **Connection Management**:
   ```typescript
   // Old way
   const client = new Client(GRPC_URL, TOKEN, undefined);
   
   // New way
   const client = await this.getClient();
   ```

3. **Stream Setup**:
   ```typescript
   const stream = await client.subscribe();
   // Send request with stream.write()
   await new Promise((resolve, reject) => {
     stream.write(request, (err) => {
       if (!err) resolve();
       else reject(err);
     });
   });
   ```

4. **Error Handling**:
   - Automatic reconnection through base class
   - Exponential backoff built-in
   - Connection released on stop

## Test Results

✅ **Connection Pool Integration**: Working correctly
✅ **Subscription Setup**: Successfully established
✅ **Error Handling**: Properly configured
✅ **Resource Management**: Clean shutdown verified
✅ **Pool Statistics**: Accurately tracked

## Benefits of Migration

1. **Rate Limit Protection**: No more 429 errors
2. **Connection Reuse**: Efficient resource usage
3. **Automatic Reconnection**: Built-in resilience
4. **Centralized Monitoring**: Pool-wide statistics
5. **Simplified Code**: Less boilerplate

## Monitoring

### Pool Statistics
The pooled version provides real-time statistics:
- Connection count and health
- Rate limit usage
- Monitor-to-connection mapping

### Health Checks
The startup script includes:
- Minute-by-minute health checks
- Connection status monitoring
- Rate limit warnings

## Rollback Plan

If issues arise, the original monitor is still available:
1. Stop the pooled version
2. Run `npm run rlmonitor:mint` to use original
3. Both versions can coexist (not simultaneously)

## Next Steps

Other monitors ready for migration:
1. ✅ Raydium Launchpad Mint Monitor (completed)
2. ⏳ Pump.fun Token Mint Monitor
3. ⏳ Pump.fun Price Monitor
4. ⏳ Pump.fun Account Monitor
5. ⏳ Pump.fun Transaction Monitor
6. ⏳ Raydium Account Monitor
7. ⏳ Graduation Monitor

## Performance Comparison

| Metric | Original | Pooled |
|--------|----------|---------|
| Connection Creation | Every start | Once, then reused |
| Rate Limit Protection | None | Automatic |
| Reconnection | Manual | Automatic with backoff |
| Monitoring | Per-monitor | Centralized |
| Resource Usage | Higher | Lower (shared connections) |

## Critical Implementation Note

When migrating monitors to use the connection pool, ensure the data structure is passed correctly:

```typescript
// CORRECT - Pass data.transaction to processTransaction
stream.on('data', async (data: any) => {
  if (data?.transaction) {
    await this.processTransaction(data.transaction);
  }
});

// Then in processTransaction:
private async processTransaction(transaction: any): Promise<void> {
  const txn = this.txnFormatter.formTransactionFromJson(transaction, Date.now());
  // ...
}
```

This follows the same pattern as the original monitor and Shyft examples.

## Conclusion

The migration was successful and the monitor is now production-ready with improved reliability and resource efficiency. Both the original and pooled monitors are detecting initialize instructions correctly. The same pattern can be applied to migrate the remaining 6 monitors.