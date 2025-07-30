# Database Module

## Overview

This module handles data persistence for the Megatron V2 trading system, storing token information captured from Solana blockchain monitors.

## Setup

1. **Prerequisites**:
   - PostgreSQL 15+ with TimescaleDB extension
   - Database credentials in `.env` file

2. **Initialize Database**:
   ```bash
   npm run db:setup
   ```

## Available Scripts

- `npm run db:setup` - Create tables and indexes
- `npm run db:validate` - Check database content and integrity
- `npm run check-tx <signature>` - Analyze specific blockchain transaction

## Database Schema

### Tokens Table
- `mint_address` - Token mint address (primary identifier)
- `symbol` - Token symbol (if available)
- `name` - Token name (if available)
- `platform` - Source platform ('pumpfun' or 'raydium_launchpad')
- `creator_address` - Token creator wallet
- `creation_signature` - Transaction that created the token
- `creation_timestamp` - When token was created on-chain
- `metadata` - Additional platform-specific data (JSON)

## Monitor Integration

The monitors automatically save new tokens to the database:

### Raydium Launchpad
```typescript
import { saveRaydiumToken } from '../database/monitor-integration';
// Token saved automatically when detected
```

### Pump.fun
```typescript
import { savePumpfunToken } from '../database/monitor-integration';
// Token saved automatically when detected
```

## Data Validation

Check stored tokens:
```bash
npm run db:validate
```

This shows:
- Recent tokens captured
- Platform distribution
- Data completeness metrics
- Signature/address validation

## Production Notes

- Duplicate tokens are handled automatically (ON CONFLICT)
- All times stored in UTC
- Metadata preserved as JSONB for flexibility
- Indexes optimized for common queries