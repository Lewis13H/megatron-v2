# Raydium Launchpad Monitor

A comprehensive monitoring solution for Raydium Launchpad on Solana, built with TypeScript and gRPC streaming.

## Features

- **New Token/Pool Monitor**: Detects new token mints and pool initializations
- **Transaction Monitor**: Tracks all transaction types (pool creation, buys, sells, liquidity operations)
- **Account Monitor**: Monitors real-time account state changes

## Prerequisites

- Node.js 16+ 
- TypeScript
- A gRPC endpoint URL and authentication token

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file with your gRPC credentials:

```env
GRPC_URL=your_grpc_endpoint_url
X_TOKEN=your_auth_token
```

## Usage

### Monitor New Token Mints/Pools
```bash
npm start
```

### Monitor All Transactions
```bash
npm run monitor:tx
```

### Monitor Account Updates
```bash
npm run monitor:account
```

## Build

```bash
npm run build
```

## Architecture

The monitors use:
- `@triton-one/yellowstone-grpc` for real-time Solana data streaming
- `@shyft-to/solana-transaction-parser` for instruction parsing
- `@coral-xyz/anchor` for IDL-based decoding
- Raydium Launchpad IDL for program-specific parsing

## Data Extraction

### Transaction Types
- **POOL_CREATION**: New liquidity pool initialization
- **BUY**: Token purchase transactions
- **SELL**: Token sale transactions
- **ADD_LIQUIDITY**: Liquidity provision
- **REMOVE_LIQUIDITY**: Liquidity removal

### Account Data
Monitors decode pool state accounts including:
- Token supply and decimals
- Trading volumes
- Virtual and real reserves
- Fundraising progress
- Fee accumulation