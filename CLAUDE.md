# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Megatron V2 is a sophisticated Solana memecoin trading system that monitors token launches on Pump.fun and Raydium platforms. The system uses gRPC streaming (via Yellowstone/Shyft) to detect new tokens, analyze trading patterns, and identify high-probability opportunities.

**Core Goal**: Analyze 100,000+ tokens weekly, identifying trades with 300%+ return potential while minimizing exposure to rug pulls through ML-driven predictions and a comprehensive 999-point scoring system.

## Development Commands

### Building & Type Checking
```bash
# Build TypeScript files
npm run build

# Type checking (use TypeScript compiler directly)
npx tsc --noEmit

# Note: ESLint not configured - consider adding for linting
```

### Monitor Commands

#### Pump.fun Monitors
```bash
# Monitor new token mints on Pump.fun
npm run pfmonitor:mint

# Monitor Pump.fun account updates (bonding curve state)
npm run pfmonitor:account

# Monitor Pump.fun transactions (all trade activity)
npm run pfmonitor:transaction

# Monitor Pump.fun token prices (real-time price updates)
npm run pfmonitor:price
```

#### Raydium Launchpad Monitors
```bash
# Monitor new token mints on Raydium Launchpad
npm run rlmonitor:mint

# Monitor all transactions on Raydium Launchpad
npm run rlmonitor:trans

# Monitor account updates on Raydium Launchpad (v1/v2/v3 available)
npm run rlmonitor:account
npm run rlmonitor:account:v2
npm run rlmonitor:account:v3
```

#### PumpSwap Monitors (Alternative AMM)
```bash
# Monitor new pools on PumpSwap
npm run pumpswap:pool

# Monitor PumpSwap account updates
npm run pumpswap:account

# Monitor PumpSwap transactions
npm run pumpswap:transaction

# Monitor PumpSwap prices
npm run pumpswap:price
```

#### Graduation & Scoring Monitors
```bash
# Monitor token graduations (Pump.fun → Raydium migrations)
npm run graduation:monitor

# Scan for graduated tokens
npm run graduation:scan

# Find graduated pools
npm run graduation:find-pools

# Add graduated pool manually
npm run graduation:add-pool

# Monitor technical scores in real-time
npm run score:monitor

# Monitor holder scores
npm run holder:monitor

# Smart holder score monitoring (optimized)
npm run holder:smart
```

### Database Commands
```bash
# Initialize database with all tables and functions
npx ts-node src/database/setup/setup-database.ts

# Set up individual components
npx ts-node src/database/setup/02-setup-pools.ts
npx ts-node src/database/setup/03-setup-transactions.ts

# Run technical scoring migration
npm run score:migrate
# Or directly:
npx tsx src/database/setup/run-technical-scoring-migration.ts

# Fix technical scoring functions (if needed)
npx tsx src/database/setup/fix-technical-scoring-functions.ts

# WARNING: Truncate all data (use with extreme caution)
npm run db:truncate
```

### Dashboard & API Commands
```bash
# Start API server (default port 3001)
npm run dashboard:serve

# Start dashboard with auto-reload (development)
npm run dashboard:serve:dev

# Access dashboard at: http://localhost:3001
```

### SOL Price Service Commands
```bash
# Start SOL/USD price updater service
npm run sol-price:updater

# Migrate to SOL price v2 architecture
npm run sol-price:migrate
```

### Environment Setup
Create a `.env` file with:
```
# gRPC Configuration (Required)
GRPC_URL=your_grpc_endpoint_url
X_TOKEN=your_auth_token

# Database Configuration (Required)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=megatron_v2
DB_USER=postgres
DB_PASSWORD=your_database_password

# Optional: API Keys for enhanced features
HELIUS_API_KEY=your_helius_api_key
PINATA_API_KEY=your_pinata_api_key
PINATA_SECRET_KEY=your_pinata_secret_key
```

## Architecture Overview

### Core Monitoring System
The monitoring system (`src/monitors/`) implements real-time blockchain data streaming:

#### Platform-Specific Monitors
1. **Pump.fun Suite** (4 specialized monitors):
   - **Token Mint Monitor**: Captures new launches with metadata via IPFS
   - **Price Monitor**: Real-time price updates on every buy/sell
   - **Account Monitor**: Tracks bonding curve state and reserves
   - **Transaction Monitor**: Complete trade history for analysis

2. **Raydium Launchpad**:
   - Monitors new token launches and pool creation
   - Tracks trading activity and liquidity changes
   - Multiple versions (v1/v2/v3) for different implementation stages

3. **Graduation System**:
   - Tracks token migrations from Pump.fun to Raydium
   - Identifies successful graduations at 84 SOL threshold
   - Records migration platform and timing

### Key Technical Components

#### gRPC Streaming Infrastructure
```typescript
// Uses @triton-one/yellowstone-grpc for real-time Solana data
// Subscription filters for specific programs
// Automatic reconnection logic (to be implemented)
```

#### Transaction Parsing
```typescript
// @shyft-to/solana-transaction-parser with program IDLs
// Custom parsers in utils/ directories
// Event extraction and formatting
```

#### Database Layer (PostgreSQL + TimescaleDB)
```typescript
// Unified MonitorService for all operations
// Connection pooling with automatic retry
// Transaction batching (50 per batch)
// 5-minute in-memory cache
```

### Program IDs
- **Pump.fun**: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- **Raydium Launchpad**: `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`
- **PumpSwap AMM**: Check `src/monitors/pumpswap/idls/pump_amm_0.1.0.json`

## Database Schema & Integration

### Core Tables (TimescaleDB Hypertables)
- **tokens**: Token metadata and creation info
- **pools**: Liquidity pool data with virtual reserves
- **transactions**: Time-series transaction data
- **price_candles_1m**: Minute-level price aggregates
- **technical_scores**: Time-series technical scoring data
- **holder_scores**: Wallet-based holder scoring
- **graduated_tokens**: Token graduation tracking

### Database Service Usage
```typescript
import { monitorService } from '../../database';

// Save token with metadata
const tokenId = await monitorService.saveToken({
  mint_address: '...',
  symbol: '...',
  name: '...',
  uri: '...',
  image_url: '...',  // Fetched from IPFS via Pinata
  // ... other fields
});

// Save pool with calculations
const poolId = await monitorService.savePool({
  pool_address: '...',
  token_id: tokenId,
  virtual_sol_reserves: '...',
  virtual_token_reserves: '...',
  latest_price: calculatedPrice,
  bonding_curve_progress: progress,
  // ... other fields
});

// Batch save transactions (automatic batching at 50)
await monitorService.saveTransactionBatch(transactions);

// Technical score operations
await monitorService.saveTechnicalScore(tokenMint, scoreData);
const latestScore = await monitorService.getLatestTechnicalScore(tokenMint);

// Holder score operations
await monitorService.saveHolderScore(tokenMint, score);
const holderScore = await monitorService.getLatestHolderScore(tokenMint);
```

### Database Architecture
```
src/database/
├── monitor-service.ts    # Singleton service for all operations
├── connection.ts         # Connection pool with retry logic
├── base-operations.ts    # Base class for DB operations
├── cache.ts             # In-memory cache (5min TTL)
├── types.ts             # All TypeScript interfaces
└── operations/          # Individual operation classes
    ├── token.ts         # Token CRUD operations
    ├── pool.ts          # Pool management
    ├── transaction.ts   # Transaction batching
    └── price.ts         # Price aggregation
```

## Scoring System (999 Points Total)

### 1. Technical Score (333 Points) - COMPLETED
Evaluates real-time market dynamics:

- **Market Cap & Entry Optimization** (100 points)
  - Optimal range: $15-30k market cap
  - Velocity tracking for growth momentum
  
- **Bonding Curve Dynamics** (83 points)
  - Progress velocity: 0.5-2% per hour optimal
  - Sweet spot: 5-20% overall progress
  
- **Trading Health Metrics** (75 points)
  - Buy/sell ratio analysis
  - Volume trend comparison (5min vs 30min)
  - Whale concentration penalties
  
- **Sell-off Detection & Response** (75 points)
  - Real-time price drop monitoring
  - Dynamic penalty system (-40 to 40 points)
  - Recovery strength measurement

### 2. Holder Score (333 Points) - IN PROGRESS
Analyzes wallet behavior and distribution

### 3. Social Score (333 Points) - PLANNED
TweetScout API integration for social metrics

## Important Calculations

### Pump.fun Bonding Curve
```typescript
// Constants
const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000 * 1e6;  // 1.073B
const TOTAL_SELLABLE_TOKENS = 793_100_000 * 1e6;            // 793.1M
const MIGRATION_RESERVE = 206_900_000 * 1e6;                // 206.9M
const GRADUATION_THRESHOLD = 84;                            // 84 SOL

// Progress calculation (token-based method)
const tokensSold = INITIAL_VIRTUAL_TOKEN_RESERVES - virtualTokenReserves;
const progress = (tokensSold / TOTAL_SELLABLE_TOKENS) * 100;

// Price calculation
const priceInSol = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6);

// Market cap (1B token supply standard)
const marketCap = 1_000_000_000 * priceInSol * solPriceUSD;
```

## ML Graduation Prediction System (In Development)

### Overview
ML models predict token graduation from Pump.fun to Raydium with 85-90% accuracy target.

### Feature Categories (150+ total)
1. **Enhanced Technical Features** (50+)
   - Price momentum indicators (RSI, MACD, Bollinger)
   - Volume-weighted metrics (VWAP)
   - Microstructure features

2. **Temporal Pattern Features** (40+)
   - Holder growth velocity across timeframes
   - Volume acceleration patterns
   - Cyclical patterns and trend detection

3. **Holder Behavior Features** (30+)
   - Wealth distribution (Gini coefficient)
   - Concentration metrics (Herfindahl index)
   - Wallet reputation scoring

4. **Cross-Token Network Features** (20+)
   - Creator track record
   - Related token performance
   - Market regime indicators

### Implementation Pipeline
```typescript
// Feature extraction → Model training → Real-time prediction
// Models: XGBoost (primary), LSTM (temporal), Ensemble (final)
// Target: Binary classification (graduated vs not graduated)
// Window: 4-8 hour prediction horizon
```

## Development Best Practices

### Code Patterns
1. **Monitor Structure**:
   - Set up gRPC client and filters
   - Parse with IDLs and custom parsers
   - Extract and format events
   - Calculate metrics
   - Save to database via MonitorService

2. **Error Handling**:
   - Suppress known parser warnings
   - Validate data before processing
   - Implement retry logic for network operations
   - Log errors with context

3. **Performance Optimization**:
   - Stream processing with backpressure
   - Connection pooling for database
   - Batch operations where possible
   - Cache frequently accessed data

### TypeScript Configuration
- **Target**: ES2020
- **Module**: CommonJS
- **Strict**: Enabled for type safety
- **Path aliases**: Configured in tsconfig.json

### Git Workflow
- Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Keep commits atomic and focused
- Write clear commit messages explaining the why

## Current Development Status

### ✅ Completed (January 2025)
- Technical Scoring System (333 points)
- Database consolidation with unified MonitorService
- Pump.fun comprehensive monitoring suite
- Raydium Launchpad monitoring
- Graduation tracking system
- Real-time dashboard with API
- SOL price service v2
- IPFS metadata fetching via Pinata

### 🔄 In Progress
- Holder Score implementation (333 points)
- ML graduation prediction pipeline
- Enhanced error handling and reconnection

### 📋 Planned (Priority Order)
1. Complete 999-point scoring framework
2. ML model training infrastructure
3. Social Score via TweetScout API
4. Automated trading engine
5. Advanced dashboard analytics

## Quick Debugging Commands

```bash
# Check database connections
npx ts-node src/utils/check-db-connections.ts

# Test database setup
npx ts-node src/utils/test-db.ts

# Kill idle connections
psql -U postgres -d megatron_v2 -f src/utils/kill-idle-connections.sql

# Test specific features
npx ts-node src/scripts/test-txn-count.ts
npx ts-node src/scripts/test-volume-calc.ts
npx ts-node src/scripts/check-token-images.ts
```