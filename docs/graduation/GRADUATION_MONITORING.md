# Graduation Monitoring System

## Overview

The Graduation Monitoring System tracks Pump.fun tokens as they complete their bonding curve and migrate to full DEX platforms like Raydium or PumpSwap. This system is crucial for continuing to monitor and score tokens after they've "graduated" from the bonding curve.

## Key Components

### 1. Bonding Curve Completion Detection
- Monitors Pump.fun bonding curve accounts for `complete = true` flag
- Uses the bonding curve structure from Pump.fun IDL
- Triggers when a token reaches ~84 SOL in the bonding curve

### 2. Migration Transaction Detection
- Monitors transactions involving the migration account
- Captures the graduation transaction signature
- Identifies the target AMM (Raydium, PumpSwap, etc.)

### 3. Pool Creation Detection
- Monitors new pool creation on Raydium AMM V4 and CPMM
- Links graduated tokens to their new liquidity pools
- Continues price and volume tracking on the new platform

### 4. Database Updates
- Marks tokens as `is_graduated = true`
- Updates pool status to `graduated`
- Sets bonding curve progress to 100%
- Records graduation timestamp and transaction

### 5. Dashboard Display
- Shows "🎓 Graduated" status instead of "100%" progress
- Styled with green gradient and glow effect
- Maintains all scoring and monitoring capabilities

## Running the Monitor

```bash
# Run the new graduation monitor v2
npm run graduation:monitor:v2
```

## Database Schema

### Tokens Table
```sql
is_graduated BOOLEAN DEFAULT FALSE
graduation_timestamp TIMESTAMPTZ
graduation_signature VARCHAR(88)
```

### Pools Table
```sql
status VARCHAR(20) CHECK (status IN ('active', 'graduated', 'closed', 'failed'))
```

## Graduation Flow

1. **Bonding Curve Completes** (complete = true)
   - Token reaches ~84 SOL
   - Bonding curve marked as complete
   - Database updated with 100% progress

2. **Migration Transaction**
   - Pump.fun initiates migration to DEX
   - Transaction captured and parsed
   - Token marked as graduated

3. **New Pool Created**
   - Raydium/PumpSwap pool detected
   - New pool entry created in database
   - Linked to graduated token

4. **Continued Monitoring**
   - Price tracking continues on new platform
   - Technical scoring adapts to DEX metrics
   - Holder scoring continues unchanged

## API Changes

The dashboard API now includes:
```json
{
  "bondingCurveProgress": 100.0,
  "isGraduated": true,
  "platform": "raydium"
}
```

## Future Enhancements

1. **Multi-DEX Support**
   - Add PumpSwap AMM monitoring
   - Support for other Solana DEXs
   - Cross-DEX arbitrage detection

2. **Post-Graduation Metrics**
   - Track performance before/after graduation
   - Graduation success rate analysis
   - Liquidity migration patterns

3. **Advanced Scoring**
   - Adjust scoring weights for graduated tokens
   - Factor in DEX-specific metrics
   - Multi-pool aggregation