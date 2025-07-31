# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Megatron V2 is a sophisticated Solana memecoin trading system that monitors token launches on Pump.fun and Raydium platforms. The system uses gRPC streaming (via Yellowstone/Shyft) to detect new tokens, analyze trading patterns, and identify high-probability opportunities.

The goal is to analyze 100,000+ tokens weekly, identifying trades with 300%+ return potential while minimizing exposure to rug pulls through ML-driven predictions and a comprehensive 999-point scoring system.

## Development Commands

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

# Monitor Pump.fun bonding curves
npm run pfmonitor:bonding

# Monitor token graduations
npm run graduation:monitor

# Build TypeScript files
npm run build

# Run tests (when implemented)
npm test

# Lint and type check
npm run lint
npm run typecheck
```

### Database Commands
```bash
# Initialize database tables and schema
npm run db:setup

# Set up pool tables
npm run db:setup:pools

# Set up transaction tables
npm run db:setup:transactions

# Validate stored tokens
npm run db:validate

# Test pool operations
npm run db:test:pools

# Test transaction operations
npm run db:test:transactions

# Performance test transactions
npm run db:perf:transactions

# Check specific transaction
npm run check-tx <signature>
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
- **Pump.fun**: Monitors bonding curve tokens, graduations, and trading patterns
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
4. Save to database
5. Output structured data for analysis

## Database Schema

### Core Tables
- **tokens**: Token metadata and creation info
- **pools**: Liquidity pool data with virtual reserves
- **transactions**: Time-series transaction data (hypertable)

### Monitor Integration
Monitors automatically save data using:
```typescript
import { savePumpfunToken } from '../../database/monitor-integration';
import { saveRaydiumToken } from '../../database/monitor-integration';
```

## Important Implementation Details

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
- ✅ Pump.fun monitor implementation
- ✅ Transaction and account monitoring infrastructure
- ✅ Database integration with PostgreSQL + TimescaleDB
- ✅ Basic event parsing and formatting
- ✅ gRPC streaming setup

### In Progress
- 🔄 Enhanced error handling and reconnection logic
- 🔄 Scoring system implementation
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