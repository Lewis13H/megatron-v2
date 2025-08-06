# Megatron V2 Issues and Fixes

## Critical Issues (Fix Immediately)

### 1. Incorrect Price Calculation in Account Monitor
**Problem:** Using virtual reserves incorrectly for price calculation

**Current (Wrong):**
```javascript
const K = virtualTokenReserves * virtualSolReserves;
const currentTokenReserves = virtualTokenReserves - tokensSold;
```

**Fix:**
```javascript
// CORRECT - Use real reserves with decimal adjustment
const priceInSol = (realQuote / Math.pow(10, 9)) / (realBase / Math.pow(10, baseDecimals));
// OR use the constant product formula correctly
const K = virtualBase * virtualQuote;
// Price = virtualQuote / virtualBase (with decimal adjustments)
```

**File:** `src/monitors/raydium-launchpad/raydium-launchpad-account-monitor.ts`

### 2. Field Name Mismatch Between Decoder and Monitor
**Problem:** Anchor decoder returns camelCase, monitor expects snake_case

**Issue:**
```javascript
// Decoder returns: baseMint, quoteMint, realBase
// Monitor expects: base_mint, quote_mint, real_base
```

**Fix:** Add field name transformation after decoding
```javascript
function transformFieldNames(obj: any) {
  const transformed: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    transformed[snakeKey] = value;
  }
  return transformed;
}

// In decoder:
parsedAccount = transformFieldNames(coder.decodeAny(dataTx?.data));
```

**File:** `src/monitors/raydium-launchpad/utils/raydium-launchpad-account-processor.ts`

### 3. Bonding Curve Progress Using Wrong Metric
**Problem:** Using token-based progress instead of SOL-based

**Current (May be wrong for Raydium):**
```javascript
const tokenProgress = (tokensSold / totalBaseSell) * 100;
```

**Fix:** Verify Raydium's graduation mechanism and use appropriate calculation
```javascript
// If SOL-based graduation (verify with Raydium docs):
const solProgress = (realQuote / totalQuoteFundRaising) * 100;
// If token-based is correct, document why
```

**File:** `src/monitors/raydium-launchpad/raydium-launchpad-account-monitor.ts`

## High Priority Issues

### 4. Hardcoded Token Decimals
**Problem:** Assumes all tokens have 6 decimals

**Current:**
```javascript
tokenAmount = parseInt(parsedTx.data.amountOut) / 1e6; // Assumes 6
```

**Fix:** Fetch decimals from mint account
```javascript
// Add to transaction processing
const tokenMint = await connection.getParsedAccountInfo(new PublicKey(baseMint));
const decimals = tokenMint.value?.data.parsed.info.decimals || 6;
tokenAmount = parseInt(parsedTx.data.amountOut) / Math.pow(10, decimals);
```

**File:** `src/monitors/raydium-launchpad/raydium-launchpad-transaction-monitor.ts`

### 5. Race Condition: Token/Pool Creation
**Problem:** Pool creation can fail if token doesn't exist in DB yet

**Fix:** Implement retry queue
```javascript
// Add retry mechanism
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

async function savePoolWithRetry(poolData: PoolData, tokenMint: string, retries = 0) {
  try {
    await poolOperations.insertPoolWithToken(poolData, tokenMint);
  } catch (error) {
    if (error.message?.includes('Token not found') && retries < MAX_RETRIES) {
      console.log(`Retry ${retries + 1}/${MAX_RETRIES} in ${RETRY_DELAY}ms`);
      setTimeout(() => savePoolWithRetry(poolData, tokenMint, retries + 1), RETRY_DELAY);
    } else {
      throw error;
    }
  }
}
```

**Files:** Both monitor files

## Medium Priority Issues

### 6. Dangerous Hex String Conversion
**Problem:** Converting any hex-looking string to number

**Current:**
```javascript
/^[0-9a-fA-F]+$/.test(obj[key]) // Too broad
```

**Fix:** Whitelist specific fields
```javascript
const NUMERIC_FIELDS = new Set(['real_base', 'real_quote', 'virtual_base', 'virtual_quote', 
                                'amount_in', 'amount_out', 'total_base_sell']);
if (NUMERIC_FIELDS.has(key) && typeof obj[key] === 'string' && /^[0-9a-fA-F]+$/.test(obj[key])) {
  // Safe to convert
}
```

**File:** `src/monitors/raydium-launchpad/utils/bn-layout-formatter.ts`

### 7. Silent Error Failures
**Problem:** Event parser returns empty array on errors

**Fix:** Add proper error handling
```javascript
parseEvent(txn: VersionedTransactionResponse): { events: any[], errors?: string[] } {
  const errors: string[] = [];
  try {
    // ... parsing logic
  } catch (e) {
    errors.push(`Event parsing failed: ${e.message}`);
    return { events: [], errors };
  }
  return { events, errors: errors.length > 0 ? errors : undefined };
}
```

**File:** `src/monitors/raydium-launchpad/utils/event-parser.ts`

### 8. Missing Null/Undefined Checks
**Problem:** No validation before parsing numbers

**Current:**
```javascript
const virtualTokenReserves = parseFloat(poolState.virtual_base); // Can be NaN
```

**Fix:** Add comprehensive validation
```javascript
function safeParseFloat(value: any, defaultValue = 0): number {
  if (value === null || value === undefined) return defaultValue;
  const parsed = typeof value === 'string' ? parseFloat(value) : Number(value);
  return isNaN(parsed) ? defaultValue : parsed;
}
```

**Files:** All monitor files

## Low Priority Issues

### 9. Incomplete Transaction Type Detection
**Problem:** Only checks instruction name

**Fix:** Add multiple validation criteria
```javascript
function determineTransactionType(instructions: any[], accounts: any[]): TransactionType {
  const hasInitialize = instructions.some(ix => ix.name === "initialize");
  const hasPoolState = accounts.some(acc => acc.name === "pool_state");
  const hasBaseMint = accounts.some(acc => acc.name === "base_mint");
  
  if (hasInitialize && hasPoolState && hasBaseMint) {
    return TransactionType.POOL_CREATION;
  }
  // ... more comprehensive checks
}
```

**File:** `src/monitors/raydium-launchpad/raydium-launchpad-transaction-monitor.ts`

### 10. Object Mutation in Formatter
**Problem:** Directly mutates input object

**Fix:** Create immutable version
```javascript
export function bnLayoutFormatter(input: any): any {
  const obj = JSON.parse(JSON.stringify(input)); // Deep clone
  // ... rest of the logic
  return obj;
}
```

**File:** `src/monitors/raydium-launchpad/utils/bn-layout-formatter.ts`

### 11. Memory Leak from Stream Backpressure
**Problem:** Async handlers without flow control

**Fix:** Implement queue with backpressure
```javascript
const queue = new Queue({ concurrency: 5 });
stream.on("data", (data) => {
  queue.add(async () => {
    await processData(data);
  });
});
```

**Files:** Both monitor files

### 12. Missing Pool Status Validation
**Problem:** Processing graduated pools as active

**Fix:** Add status checks
```javascript
if (poolState.status === 2) {
  console.log("Pool already graduated, skipping active pool processing");
  return;
}
```

**File:** `src/monitors/raydium-launchpad/raydium-launchpad-account-monitor.ts`

## Implementation Priority

1. **Week 1:** Fix Critical Issues 1-3
2. **Week 2:** Fix High Priority Issues 4-5
3. **Week 3:** Fix Medium Priority Issues 6-8
4. **Week 4:** Fix Low Priority Issues 9-12

## Testing Requirements

- Unit tests for all calculation fixes
- Integration tests for race condition scenarios
- Performance tests for memory leak fixes
- End-to-end tests for transaction processing flow