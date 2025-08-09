# Shyft gRPC Best Practices

Based on official Shyft documentation review, here are the key best practices for using Yellowstone gRPC:

## 1. Slot Replay for Reconnection

**Why**: Ensures no data loss during disconnections.

```typescript
// Store last slot during streaming
let lastSlot: bigint;

stream.on('data', (data) => {
  if (data.slot) {
    lastSlot = BigInt(data.slot);
  }
});

// When reconnecting, replay from last slot
const request = {
  // ... your filters
  slots: {
    slots: {},
    fromSlot: lastSlot // Resume from last known slot
  }
};
```

**Note**: The earliest available slot is ~150 slots behind current.

## 2. Dynamic Subscription Updates

**Why**: Modify subscriptions without losing connection.

```typescript
// Update subscription mid-stream
await stream.updateSubscription({
  transactions: {
    updated: {
      accountInclude: [...newAddresses],
      // ... other filters
    }
  }
});
```

**Use Cases**:
- Add new pool addresses to monitor
- Remove inactive addresses
- Adjust filters based on conditions

## 3. Graceful Stream Closure

**Why**: Properly releases server resources.

```typescript
// Correct way to close
await stream.cancel();

// Handle cancellation in error handler
stream.on('error', (err) => {
  if (err.code === 1 || err.message?.includes('Cancelled')) {
    console.log('Stream cancelled gracefully');
    return; // Not an error
  }
  // Handle actual errors
});
```

## 4. Commitment Levels

Choose based on your needs:
- `PROCESSED` - Fastest, may include reverted transactions
- `CONFIRMED` - Good balance of speed and reliability
- `FINALIZED` - Slowest but guaranteed permanent

```typescript
const request = {
  transactions: { /* filters */ },
  commitment: CommitmentLevel.CONFIRMED // Recommended for most cases
};
```

## 5. Block Streaming Requirements

**Important**: Must include at least one filter when streaming blocks.

```typescript
// ❌ Won't work - no filters
const request = {
  blocks: {}
};

// ✅ Correct - includes filter
const request = {
  blocks: {
    myBlocks: {
      accountInclude: [poolAddress],
      includeTransactions: true
    }
  }
};
```

## 6. Connection Management

### Rate Limiting
- 60 connections per 60 seconds limit
- Use connection pooling (already implemented)

### Health Monitoring
```typescript
// Monitor stream health
let lastMessageTime = Date.now();

stream.on('data', () => {
  lastMessageTime = Date.now();
});

// Check for stalled streams
setInterval(() => {
  if (Date.now() - lastMessageTime > 30000) {
    console.warn('Stream may be stalled');
    // Reconnect
  }
}, 10000);
```

## 7. Error Handling Strategy

```typescript
class RobustMonitor {
  private retryCount = 0;
  private maxRetries = 10;
  
  async handleError(error: Error) {
    // Exponential backoff
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
    
    if (this.retryCount >= this.maxRetries) {
      console.error('Max retries reached');
      return;
    }
    
    this.retryCount++;
    await sleep(delay);
    await this.reconnect();
  }
  
  async reconnect() {
    // Reconnect with slot replay
    await this.startStream(this.lastSlot);
  }
}
```

## 8. Filter Logic

Remember the logical operators:
- **Between fields**: AND logic
- **Within arrays**: OR logic

```typescript
{
  accountInclude: [addr1, addr2], // addr1 OR addr2
  accountExclude: [addr3],        // AND NOT addr3
  vote: false                      // AND vote=false
}
```

## 9. Production Recommendations

1. **Always implement slot replay** for production systems
2. **Use CONFIRMED commitment** unless you need faster updates
3. **Monitor stream health** with heartbeat checks
4. **Log all disconnections** for debugging
5. **Implement circuit breakers** for repeated failures
6. **Track metrics**: messages/sec, errors, reconnections

## 10. Common Pitfalls to Avoid

- ❌ Not handling "Cancelled" errors as normal closure
- ❌ Forgetting to track slots for replay
- ❌ Using PROCESSED commitment for critical data
- ❌ Not implementing reconnection logic
- ❌ Streaming blocks without filters
- ❌ Creating new connections instead of reusing

## Implementation Checklist

- [ ] Implement slot tracking and replay
- [ ] Handle graceful cancellation
- [ ] Set appropriate commitment level
- [ ] Add stream health monitoring
- [ ] Implement exponential backoff
- [ ] Use connection pooling
- [ ] Add metrics collection
- [ ] Test reconnection scenarios
- [ ] Monitor rate limits
- [ ] Log important events

## Example: Production-Ready Monitor

See `src/grpc/monitor-adapter-v2.ts` for a complete implementation following all these best practices.