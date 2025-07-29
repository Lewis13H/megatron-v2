# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Megatron V2 is a Solana memecoin trading system that monitors token launches on Pump.fun and Raydium platforms. The system uses gRPC streaming (via Yellowstone/Shyft) to detect new tokens, analyze trading patterns, and identify high-probability opportunities.

## Development Commands

### Running Monitors
```bash
# Monitor new token mints on Raydium Launchpad
npm run rlmonitor:mint

# Monitor all transactions on Raydium Launchpad
npm run rlmonitor:trans

# Monitor account updates on Raydium Launchpad
npm run rlmonitor:account

# Build TypeScript files
npm run build
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

## Future Development Areas

Based on TECHNICAL_OVERVIEW.md:
1. **ML Prediction Engine**: Graduation probability model
2. **Scoring System**: 999-point evaluation framework
3. **Trading Strategy Engine**: Automated entry/exit logic
4. **Data Pipeline**: Handle 100k tokens/week target
5. **Social Analytics Integration**: TweetScout API integration