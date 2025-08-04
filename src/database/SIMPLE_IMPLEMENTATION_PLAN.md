# Simple Database Implementation Plan

## Goal
Fix connection issues and improve efficiency without over-engineering. Keep it simple and practical.

## Immediate Fixes (Day 1)

### 1. Fix Connection Pool Management
```typescript
// src/database/connection.ts - Enhanced but simple
import { Pool, PoolClient } from 'pg';

class DatabaseConnection {
  private static pool: Pool | null = null;
  
  static getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        // existing config...
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000, // Increase from 2000
      });
      
      // Add basic error recovery
      this.pool.on('error', (err) => {
        console.error('Pool error:', err);
        // Don't exit, just log
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
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    throw new Error('Max retries exceeded');
  }
  
  private static isRetryable(error: any): boolean {
    return error.code === 'ECONNREFUSED' || 
           error.code === 'ETIMEDOUT' ||
           error.message?.includes('Connection terminated');
  }
}

export const db = DatabaseConnection;
```

### 2. Simplify Operations Classes
Instead of complex repositories, just improve existing classes:

```typescript
// src/database/base-operations.ts
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
  async query(text: string, params?: any[]): Promise<any> {
    return db.withRetry(() => this.pool.query(text, params));
  }
}
```

## Week 1: Consolidation

### 1. Merge Integration Files
Combine `monitor-integration.ts` and `transaction-monitor-integration.ts`:

```typescript
// src/database/monitor-service.ts
export class MonitorService {
  private tokenOps = new TokenOperations();
  private poolOps = new PoolOperations();
  private txOps = new TransactionOperations();
  
  // Single method for all token saves
  async saveToken(data: TokenData) {
    return this.tokenOps.create(data);
  }
  
  // Single method for all transactions
  async saveTransaction(data: TransactionData) {
    return this.txOps.create(data);
  }
  
  // Batch operations for performance
  async saveTransactionBatch(transactions: TransactionData[]) {
    return this.txOps.createBatch(transactions);
  }
}
```

### 2. Add Batch Operations
Critical for handling high transaction volume:

```typescript
// src/database/transaction-operations.ts
export class TransactionOperations extends BaseOperations {
  async createBatch(transactions: Transaction[]): Promise<void> {
    if (transactions.length === 0) return;
    
    const query = `
      INSERT INTO transactions (
        signature, pool_id, token_id, block_time, slot, type,
        user_address, sol_amount, token_amount, price_per_token
      ) VALUES ${transactions.map((_, i) => 
        `($${i*10+1}, $${i*10+2}, $${i*10+3}, $${i*10+4}, $${i*10+5}, 
          $${i*10+6}, $${i*10+7}, $${i*10+8}, $${i*10+9}, $${i*10+10})`
      ).join(', ')}
      ON CONFLICT (signature, block_time) DO NOTHING
    `;
    
    const values = transactions.flatMap(tx => [
      tx.signature, tx.pool_id, tx.token_id, tx.block_time, tx.slot,
      tx.type, tx.user_address, tx.sol_amount, tx.token_amount, tx.price_per_token
    ]);
    
    await this.query(query, values);
  }
}
```

### 3. Simple Caching
Add basic in-memory cache for lookups:

```typescript
// src/database/cache.ts
export class SimpleCache<T> {
  private cache = new Map<string, { value: T; expires: number }>();
  private ttl: number;
  
  constructor(ttlSeconds = 300) { // 5 minutes default
    this.ttl = ttlSeconds * 1000;
  }
  
  get(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }
  
  set(key: string, value: T): void {
    this.cache.set(key, {
      value,
      expires: Date.now() + this.ttl
    });
  }
  
  clear(): void {
    this.cache.clear();
  }
}
```

## Week 2: Monitor Updates

### 1. Update All Monitors
Replace direct database calls with MonitorService:

```typescript
// In monitors
import { monitorService } from '../../database';

// Instead of complex integration
await monitorService.saveToken({
  mint_address: tokenData.mint,
  symbol: tokenData.symbol,
  // ...
});

// Batch transactions
const transactions = events.map(event => ({
  signature: event.signature,
  type: event.type,
  // ...
}));
await monitorService.saveTransactionBatch(transactions);
```

### 2. Remove Redundancy
- Delete `getCurrentSolPrice()` from monitor-integration.ts
- Use SQL function: `SELECT get_latest_sol_usd_price()`
- Remove `enhanced-price-operations.ts` if not adding value

## Implementation Priority

### Must Do (Fix Current Issues)
1. ✅ Fix connection pool singleton
2. ✅ Add retry logic for database operations
3. ✅ Implement batch inserts for transactions
4. ✅ Merge integration files into MonitorService

### Should Do (Improve Efficiency)
1. Add simple caching for token/pool lookups
2. Update monitors to use new MonitorService
3. Clean up redundant code
4. Add basic error logging

### Nice to Have (Future)
1. Connection health monitoring
2. Query performance metrics
3. Redis caching (as originally planned)

## File Structure After Implementation

```
src/database/
├── connection.ts          # Enhanced connection with retry
├── base-operations.ts     # Base class for all operations
├── monitor-service.ts     # Unified monitor integration
├── cache.ts              # Simple in-memory cache
├── operations/
│   ├── token.ts          # TokenOperations extends BaseOperations
│   ├── pool.ts           # PoolOperations extends BaseOperations
│   ├── transaction.ts    # TransactionOperations with batch
│   └── price.ts          # PriceOperations extends BaseOperations
├── types.ts              # All TypeScript interfaces
└── index.ts              # Clean exports
```

## Benefits
- **Simple**: No complex patterns, just practical improvements
- **Fixes Issues**: Solves connection pool and retry problems
- **Better Performance**: Batch operations for high volume
- **Maintainable**: Clear structure, less code duplication
- **Incremental**: Can implement piece by piece

## Success Metrics
- No more "pool ended" errors
- Transaction insertion handles 19k+ TPS
- Monitors run without database failures
- Code reduced from ~1,900 to ~1,200 lines