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

# Monitor new token mints on Pump.fun (when implemented)
npm run pump:mint

# Build TypeScript files
npm run build

# Run tests (when implemented)
npm test

# Lint and type check
npm run lint
npm run typecheck
```

### Environment Setup
Create a `.env` file with:
```
GRPC_URL=your_grpc_endpoint_url
X_TOKEN=your_auth_token
```

## Architecture Overview

### Core Monitoring System
The main application logic is in `src/monitors/` with separate monitors for different platforms:
- **Raydium Launchpad**: Monitors new token launches, pool creation, and trading activity
- **Pump.fun**: (To be implemented) Monitors bonding curve tokens

### Key Components
1. **gRPC Streaming**: Uses `@triton-one/yellowstone-grpc` for real-time Solana data
2. **Transaction Parsing**: Uses `@shyft-to/solana-transaction-parser` with program IDLs
3. **Event Processing**: Custom formatters and parsers in `utils/` directories

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

### Error Handling
- Suppress known parser warnings for unrecognized programs
- Handle gRPC reconnection (to be implemented)
- Validate account data before processing

### Data Processing Flow
1. Stream data via gRPC subscription
2. Parse using Anchor IDLs and custom parsers
3. Format using utility functions
4. Output structured data for analysis

## Important Implementation Details

### TypeScript Configuration
- Strict mode enabled for type safety
- ES2022 target with Node module resolution
- Path aliases configured in `tsconfig.json`

### Testing Strategy
- Unit tests for parsers and formatters
- Integration tests for monitors
- Mock gRPC streams for testing

### Performance Considerations
- Stream processing with backpressure handling
- Efficient memory usage for high-volume data
- Connection pooling for external APIs

## Current Development Status

### Completed
- ✅ Raydium Launchpad new token mint monitor
- ✅ Transaction and account monitoring infrastructure
- ✅ Basic event parsing and formatting
- ✅ gRPC streaming setup

### In Progress
- 🔄 Pump.fun monitor implementation
- 🔄 Data persistence layer
- 🔄 Enhanced error handling and reconnection logic

### Planned (Priority Order)
1. **Data Storage**: PostgreSQL + TimescaleDB for historical data
2. **Scoring System**: Implement 999-point evaluation framework
3. **ML Pipeline**: Feature extraction and model training infrastructure
4. **Trading Engine**: Signal generation and execution logic
5. **Social Integration**: TweetScout API for social metrics
6. **Dashboard**: Real-time monitoring and analytics UI

## Future Development Areas

Based on TECHNICAL_OVERVIEW.md:
1. **ML Prediction Engine**: Graduation probability model
2. **Scoring System**: 999-point evaluation framework
3. **Trading Strategy Engine**: Automated entry/exit logic
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