# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Megatron V2 is a sophisticated Solana memecoin trading system that monitors token launches on Pump.fun and Raydium platforms. The system uses gRPC streaming (via Yellowstone/Shyft) to detect new tokens, analyze trading patterns, and identify high-probability opportunities.

The goal is to analyze 100,000+ tokens weekly, identifying trades with 300%+ return potential while minimizing exposure to rug pulls through ML-driven predictions and a comprehensive 999-point scoring system.

## Development Commands

### Technical Scoring System
```bash
# Monitor technical scores in real-time
npm run score:monitor

# Run database migration for technical scoring
npx tsx src/database/setup/run-technical-scoring-migration.ts

# Fix technical scoring functions (if needed)
npx tsx src/database/setup/fix-technical-scoring-functions.ts
```

### Running Monitors
```bash
# Monitor new token mints on Raydium Launchpad
npm run rlmonitor:mint

# Monitor all transactions on Raydium Launchpad
npm run rlmonitor:trans

# Monitor account updates on Raydium Launchpad
npm run rlmonitor:account

# Monitor new token mints on Pump.fun
npm run pfmonitor:mint

# Monitor Pump.fun account updates
npm run pfmonitor:account

# Monitor Pump.fun transactions
npm run pfmonitor:transaction

# Monitor Pump.fun token prices (real-time price updates)
npm run pfmonitor:price

# Monitor token graduations
npm run graduation:monitor

# Build TypeScript files
npm run build

# Type checking (use TypeScript compiler directly)
npx tsc --noEmit

# Linting (ESLint not configured - consider adding)
# npm run lint
```

### Database Commands
```bash
# Initialize database with all tables
npx ts-node src/database/setup/setup-database.ts

# Set up individual components
npx ts-node src/database/setup/02-setup-pools.ts
npx ts-node src/database/setup/03-setup-transactions.ts

# Truncate all data (use with caution)
npm run db:truncate
```

### Dashboard & API Commands
```bash
# Start API server (default port 3001)
npm run dashboard:serve

# Start dashboard with auto-reload (development)
npm run dashboard:serve:dev
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
GRPC_URL=your_grpc_endpoint_url
X_TOKEN=your_auth_token

# Database configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_database_name
DB_USER=your_database_user
DB_PASSWORD=your_database_password
```

## Architecture Overview

### Core Monitoring System
The main application logic is in `src/monitors/` with separate monitors for different platforms:
- **Raydium Launchpad**: Monitors new token launches, pool creation, and trading activity
- **Pump.fun**: Comprehensive monitoring suite with 4 specialized monitors:
  - **Token Mint Monitor**: Captures new token launches with metadata
  - **Price Monitor**: Real-time price updates on every buy/sell transaction
  - **Account Monitor**: Tracks bonding curve state and reserves
  - **Transaction Monitor**: Records all transaction types for analysis
- **Graduation**: Tracks token migrations from Pump.fun to other platforms

### Key Components
1. **gRPC Streaming**: Uses `@triton-one/yellowstone-grpc` for real-time Solana data
2. **Transaction Parsing**: Uses `@shyft-to/solana-transaction-parser` with program IDLs
3. **Event Processing**: Custom formatters and parsers in `utils/` directories
4. **Database Layer**: PostgreSQL with TimescaleDB for time-series data

### Program IDs
- Raydium Launchpad: `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`
- Pump.fun: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`

## Code Patterns

### Monitor Structure
Each monitor follows this pattern:
1. Set up gRPC client and subscription filters
2. Parse transactions/accounts using IDL
3. Extract relevant events (pool creation, buys, sells)
4. Format and output data
5. Save to database via monitor-integration module

### Error Handling
- Suppress known parser warnings for unrecognized programs
- Handle gRPC reconnection (to be implemented)
- Validate account data before processing

### Data Processing Flow
1. Stream data via gRPC subscription
2. Parse using Anchor IDLs and custom parsers
3. Format using utility functions
4. Calculate key metrics:
   - Bonding curve progress: `((1,073,000,000 × 10^6 - virtualTokenReserves) × 100) / (793,100,000 × 10^6)`
   - Price: `(virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6)`
   - Market cap: `1,000,000,000 × price` (1 billion token supply)
5. Save to database with calculated values
6. Output structured data for analysis

## Database Schema

### Core Tables
- **tokens**: Token metadata and creation info
- **pools**: Liquidity pool data with virtual reserves
- **transactions**: Time-series transaction data (hypertable)
- **price_candles_1m**: Minute-level price aggregates (hypertable)
- **price_candles_1m_cagg**: Continuous aggregate for efficient price queries
- **technical_scores**: Time-series technical scoring data (hypertable)
- **latest_technical_scores**: View showing current scores per token

### Database Integration (Updated January 2025)
The database layer has been consolidated into a unified MonitorService:

```typescript
import { monitorService } from '../../database';

// Save token
const tokenId = await monitorService.saveToken({
  mint_address: '...',
  symbol: '...',
  // ... other fields
});

// Save pool
const poolId = await monitorService.savePool({
  pool_address: '...',
  token_id: tokenId,
  // ... other fields
});

// Save transactions (with batching)
await monitorService.saveTransactionBatch(transactions);

// Save holder scores
await monitorService.saveHolderScore(tokenMint, score);

// Get latest holder score
const score = await monitorService.getLatestHolderScore(tokenMint);
```

#### Database Architecture
```
src/database/
├── monitor-service.ts    # Unified service for all operations
├── connection.ts         # Connection pool with retry logic
├── base-operations.ts    # Base class for operations
├── cache.ts             # In-memory cache (5min TTL)
├── types.ts             # All TypeScript interfaces
└── operations/          # Individual operation classes
    ├── token.ts
    ├── pool.ts
    ├── transaction.ts   # Supports batch operations
    └── price.ts
```

**Key Features:**
- Singleton MonitorService for all database operations
- Connection pooling with automatic retry
- Transaction batching (50 per batch)
- Simple in-memory caching
- Unified error handling

### Pump.fun Bonding Curve Mechanics
- **Initial Virtual Token Reserves**: 1,073,000,000 tokens (1.073 billion)
- **Total Sellable Tokens**: 793,100,000 tokens (793.1 million)
- **Reserved for Migration**: 206,900,000 tokens (206.9 million)
- **Graduation Threshold**: 84 SOL collected in bonding curve
- **Progress Calculation**: Based on tokens sold from virtual reserves

### Technical Scoring System (333 Points)
The Technical Score evaluates tokens based on real-time market dynamics:

1. **Market Cap & Entry Optimization (100 points)**
   - Heavily favors $15-30k market cap range (optimal entry)
   - Tracks velocity of market cap growth

2. **Bonding Curve Dynamics (83 points)**
   - Progress velocity tracking (optimal: 0.5-2% per hour)
   - Consistency and position scoring
   - Sweet spot: 5-20% progress

3. **Trading Health Metrics (75 points)**
   - Buy/sell ratio analysis
   - Volume trend comparison (5min vs 30min)
   - Whale concentration penalties

4. **Sell-off Detection & Response (75 points)**
   - Real-time price drop monitoring
   - Dynamic penalties (-40 to 40 points)
   - Recovery strength measurement

**Integration**: Scores update automatically via monitor integration with 5-second caching and debouncing for performance.

## Important Implementation Details

### Key Calculations

#### Bonding Curve Progress
```typescript
const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000 * 1e6;
const TOTAL_SELLABLE_TOKENS = 793_100_000 * 1e6;
const tokensSold = INITIAL_VIRTUAL_TOKEN_RESERVES - virtualTokenReserves;
const progress = (tokensSold / TOTAL_SELLABLE_TOKENS) * 100;
```

#### Token Price
```typescript
const priceInSol = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6);
```

### TypeScript Configuration
- Target: ES2020
- Module: CommonJS
- Strict mode enabled for type safety
- Path aliases configured in `tsconfig.json`

### Testing Strategy
- Unit tests for parsers and formatters
- Integration tests for monitors
- Mock gRPC streams for testing

### Performance Considerations
- Stream processing with backpressure handling
- Efficient memory usage for high-volume data
- Connection pooling for database operations
- TimescaleDB for optimized time-series queries

## Current Development Status

### Completed
- ✅ Raydium Launchpad new token mint monitor
- ✅ Pump.fun comprehensive monitoring suite:
  - ✅ Token mint monitor with initial price/progress calculation
  - ✅ Real-time price monitor tracking all trades
  - ✅ Account monitor with correct bonding curve progress
  - ✅ Transaction monitor for complete trade history
- ✅ Bonding curve progress calculation (token-based method)
- ✅ Accurate price calculations with proper decimal handling
- ✅ Transaction and account monitoring infrastructure
- ✅ Database integration with PostgreSQL + TimescaleDB
- ✅ Pool and transaction data storage with latest_price field
- ✅ Price aggregates and continuous views
- ✅ Real-time price tracking with 1-minute candles
- ✅ Volume statistics and high-volume token detection
- ✅ UI Viewer with real-time dashboard
- ✅ gRPC streaming setup
- ✅ **Technical Scoring System (333 points)** - COMPLETED January 2025:
  - ✅ Market Cap & Entry Optimization scoring (100 points)
  - ✅ Bonding Curve Dynamics with velocity metrics (83 points)
  - ✅ Trading Health Metrics analysis (75 points)
  - ✅ Sell-off Detection & Response system (75 points)
  - ✅ Real-time score updates integrated with monitors
  - ✅ Dashboard display with tooltips and sorting
  - ✅ Standalone score monitor with alerts
- ✅ **Database Consolidation** - COMPLETED January 2025:
  - ✅ Unified MonitorService replacing separate integration files
  - ✅ File reorganization with operations/ subdirectory
  - ✅ Centralized TypeScript types in types.ts
  - ✅ Added transaction batching (50 per batch)
  - ✅ Implemented simple caching with 5-minute TTL
  - ✅ Fixed all monitor compatibility issues
  - ✅ Removed ~400 lines of duplicate code

### In Progress
- 🔄 Enhanced error handling and reconnection logic
- 🔄 Holder Score implementation (333 points)
- 🔄 Social Score implementation (333 points)
- 🔄 ML pipeline development

### Planned (Priority Order)
1. **Scoring System**: Implement 999-point evaluation framework
2. **ML Pipeline**: Feature extraction and model training infrastructure
3. **Trading Engine**: Signal generation and execution logic
4. **Social Integration**: TweetScout API for social metrics
5. **Dashboard**: Real-time monitoring and analytics UI

## Future Development Areas

Based on TECHNICAL_OVERVIEW.md:
1. **ML Prediction Engine**: Graduation probability model
2. **Scoring System**: 999-point evaluation framework (Technical/Holder/Social scores)
3. **Trading Strategy Engine**: Automated entry/exit logic with 300% target
4. **Data Pipeline**: Handle 100k tokens/week target
5. **Social Analytics Integration**: TweetScout API integration

## Best Practices

### Code Quality
- Follow existing code patterns and conventions
- Write self-documenting code with clear variable names
- Add JSDoc comments for public APIs
- Handle errors gracefully with proper logging

### Git Workflow
- Use conventional commits (feat:, fix:, docs:, etc.)
- Keep commits atomic and focused
- Write clear commit messages explaining the why

### Security
- Never commit API keys or sensitive data
- Validate all external inputs
- Use environment variables for configuration
- Implement rate limiting for external API calls