# Pump.fun Monitoring System Implementation Guide

This guide outlines the implementation of three core monitors for tracking Pump.fun token activity using gRPC streaming.

## Overview

The monitoring system consists of three specialized monitors:
1. **Transaction Monitor** - Tracks buy/sell events and trading activity
2. **Account Monitor** - Monitors bonding curve state changes and token accounts
3. **Bonding Curve Monitor** - Tracks progression towards graduation and liquidity changes

## Prerequisites

```bash
npm install @triton-one/yellowstone-grpc @shyft-to/solana-transaction-parser @coral-xyz/anchor @solana/web3.js
```

## Monitor 1: Transaction Monitor (Buy/Sell Events)

### Purpose
Streams all Pump.fun transactions to detect and parse buy/sell events in real-time.

### Reference Example
Based on: `shyft-code-examples/PumpFun/Typescript/BC/stream_pump_fun_transactions_and_detect_buy_sell_events/`

### Implementation

```typescript
// src/monitors/pump-fun/pump-fun-transaction-monitor.ts
import Client, { CommitmentLevel, SubscribeRequestFilterTransactions } from "@triton-one/yellowstone-grpc";
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { SolanaParser } from "@shyft-to/solana-transaction-parser";
import { Idl } from "@project-serum/anchor";
import pumpFunIdl from "./idls/pump_0.1.0.json";

const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

interface SwapEvent {
  type: 'buy' | 'sell';
  user: string;
  mint: string;
  bondingCurve: string;
  solAmount: number;
  tokenAmount: number;
  timestamp: number;
}

export class PumpFunTransactionMonitor {
  private client: Client;
  private parser: SolanaParser;

  constructor() {
    this.client = new Client(process.env.GRPC_URL!, process.env.X_TOKEN!, undefined);
    this.parser = new SolanaParser([]);
    this.parser.addParserFromIdl(PUMP_FUN_PROGRAM_ID.toBase58(), pumpFunIdl as Idl);
  }

  async start() {
    const stream = await this.client.subscribe();
    
    stream.on("data", (data) => {
      if (data?.transaction) {
        const parsedEvent = this.parseSwapTransaction(data.transaction);
        if (parsedEvent) {
          console.log(`[${parsedEvent.type.toUpperCase()}]`, {
            mint: parsedEvent.mint,
            user: parsedEvent.user,
            solAmount: `${parsedEvent.solAmount} SOL`,
            tokenAmount: parsedEvent.tokenAmount,
            bondingCurve: parsedEvent.bondingCurve
          });
        }
      }
    });

    // Subscribe to Pump.fun transactions
    await stream.write({
      accounts: {},
      slots: {},
      transactions: {
        pumpFun: {
          vote: false,
          failed: false,
          accountInclude: [PUMP_FUN_PROGRAM_ID.toBase58()],
          accountExclude: [],
          accountRequired: []
        }
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED
    });
  }

  private parseSwapTransaction(txData: any): SwapEvent | null {
    // Parse transaction and extract buy/sell events
    // Implementation based on parseSwapTransactionOutput from utils/pumpfun_formatted_txn.ts
    // Key logic: Find inner instructions with name === 'buy' || 'sell'
    // Extract user, mint, bonding curve, and amounts from instruction accounts and args
    return null; // Implement based on example
  }
}
```

### Usage
```bash
npm run pfmonitor:transaction
```

## Monitor 2: Account Monitor (State Changes)

### Purpose
Monitors Pump.fun account updates to track bonding curve states and token account changes.

### Reference Example
Based on: `shyft-code-examples/PumpFun/Typescript/BC/stream_and_parse_all_pump_fun_accounts/`

### Implementation

```typescript
// src/monitors/pump-fun/pump-fun-account-monitor.ts
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import bs58 from 'bs58';

interface BondingCurveAccount {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

export class PumpFunAccountMonitor {
  private accountCoder: BorshAccountsCoder;

  constructor() {
    const idl = JSON.parse(fs.readFileSync('./idls/pump_0.1.0.json', 'utf8'));
    this.accountCoder = new BorshAccountsCoder(idl);
  }

  async start() {
    const stream = await this.client.subscribe();
    
    stream.on("data", async (data) => {
      if (data?.account) {
        const decodedAccount = this.decodeAccount(data.account);
        if (decodedAccount) {
          this.processAccountUpdate(decodedAccount);
        }
      }
    });

    // Subscribe to Pump.fun owned accounts
    await stream.write({
      accounts: {
        pumpfun: {
          account: [],
          filters: [],
          owner: [PUMP_FUN_PROGRAM_ID.toBase58()]
        }
      },
      slots: {},
      transactions: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED
    });
  }

  private decodeAccount(accountData: any): BondingCurveAccount | null {
    try {
      // Uses BorshAccountsCoder.decodeAny() as shown in the example
      const decoded = this.accountCoder.decodeAny(accountData.account.data);
      // Apply bnLayoutFormatter to handle BigNumber conversions
      return decoded as BondingCurveAccount;
    } catch {
      return null;
    }
  }

  private processAccountUpdate(account: BondingCurveAccount) {
    console.log("Bonding Curve Update:", {
      complete: account.complete,
      solReserves: Number(account.realSolReserves) / 1e9,
      tokenReserves: Number(account.realTokenReserves) / 1e9
    });
  }
}
```

### Usage
```bash
npm run pfmonitor:account
```

## Monitor 3: Bonding Curve Progress Monitor

### Purpose
Tracks bonding curve progression towards graduation using the precise formula.

### Reference Examples
Based on: 
- `shyft-code-examples/PumpFun/Typescript/BC/stream_bonding_curve_progress/` - Main progress tracking logic
- `shyft-code-examples/PumpFun/Typescript/BC/stream_completed_bonding_curve/` - Completion detection using memcmp filters

### Implementation

```typescript
// src/monitors/pump-fun/pump-fun-bonding-curve-monitor.ts
import { Connection, PublicKey } from "@solana/web3.js";

interface BondingCurveProgress {
  mint: string;
  bondingCurve: string;
  progress: number;
  solBalance: number;
  tokenBalance: number;
  isComplete: boolean;
}

export class PumpFunBondingCurveMonitor {
  private connection: Connection;
  
  // Constants for bonding curve calculation
  private readonly TOTAL_SUPPLY = 1_000_000_000;
  private readonly RESERVED_TOKENS = 206_900_000;
  private readonly INITIAL_REAL_TOKEN_RESERVES = 793_100_000;

  constructor() {
    this.connection = new Connection(process.env.RPC_URL!, 'confirmed');
  }

  async start() {
    const stream = await this.client.subscribe();
    
    stream.on("data", async (data) => {
      if (data?.transaction) {
        const bondingCurveData = await this.parseBondingCurveTransaction(data.transaction);
        if (bondingCurveData) {
          const progress = await this.calculateProgress(bondingCurveData);
          this.outputProgress(progress);
        }
      }
    });

    // Subscribe with filters for bonding curve transactions
    await stream.write({
      accounts: {},
      slots: {},
      transactions: {
        pumpFun: {
          vote: false,
          failed: false,
          accountInclude: [PUMP_FUN_PROGRAM_ID.toBase58()],
          accountExclude: [],
          accountRequired: []
        }
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED
    });
  }

  private async calculateProgress(bondingCurveAddress: string): Promise<BondingCurveProgress> {
    // Get token balance at bonding curve address
    const accountInfo = await this.connection.getAccountInfo(new PublicKey(bondingCurveAddress));
    const tokenBalance = accountInfo?.data ? this.parseTokenBalance(accountInfo.data) : 0;
    
    // Calculate progress using the formula:
    // BondingCurveProgress = 100 - (((balance - 206900000) * 100) / 793100000)
    const leftTokens = tokenBalance - this.RESERVED_TOKENS;
    const progress = 100 - ((leftTokens * 100) / this.INITIAL_REAL_TOKEN_RESERVES);
    
    // Get SOL balance (similar to getBondingCurveAddress in utils/getBonding.ts)
    const solBalance = accountInfo?.lamports || 0;
    
    return {
      mint: "", // Extract from transaction using transactionOutput utility
      bondingCurve: bondingCurveAddress,
      progress: Math.max(0, Math.min(100, progress)),
      solBalance: solBalance / 1e9,
      tokenBalance: tokenBalance,
      isComplete: progress >= 100
    };
  }

  private outputProgress(progress: BondingCurveProgress) {
    console.log(`
    BONDING CURVE PROGRESS
    =====================
    Mint: ${progress.mint}
    Bonding Curve: ${progress.bondingCurve}
    Progress: ${progress.progress.toFixed(2)}% to completion
    SOL Balance: ${progress.solBalance.toFixed(2)} SOL
    Token Balance: ${(progress.tokenBalance / 1e9).toFixed(2)}
    Status: ${progress.isComplete ? 'COMPLETED' : 'IN PROGRESS'}
    `);
  }
}
```

### Usage
```bash
npm run pfmonitor:bonding
```

## Package.json Scripts

Add these scripts to your package.json:

```json
{
  "scripts": {
    "pfmonitor:transaction": "ts-node src/monitors/pump-fun/pump-fun-transaction-monitor.ts",
    "pfmonitor:account": "ts-node src/monitors/pump-fun/pump-fun-account-monitor.ts",
    "pfmonitor:bonding": "ts-node src/monitors/pump-fun/pump-fun-bonding-curve-monitor.ts",
    "pfmonitor:all": "concurrently \"npm run pumpmonitor:transaction\" \"npm run pumpmonitor:account\" \"npm run pumpmonitor:bonding\""
  }
}
```

## Environment Variables

```env
GRPC_URL=your_yellowstone_grpc_endpoint
X_TOKEN=your_auth_token
RPC_URL=your_solana_rpc_endpoint
```

## Key Features

### Transaction Monitor
- Real-time buy/sell detection
- Trade size and direction tracking
- User wallet identification
- Price impact calculation
- Uses inner instruction parsing for accurate swap detection

### Account Monitor
- State change detection
- Graduation status tracking
- Reserve balance monitoring
- Account type identification
- Borsh decoding of account data

### Bonding Curve Monitor
- Precise progress calculation using the formula
- SOL balance tracking
- Completion detection
- Migration readiness alerts
- Memcmp filters for completed curves

## Utility Functions Reference

The examples include several key utility functions that should be adapted:

- **bnLayoutFormatter**: Converts BigNumber fields to readable formats
- **TransactionFormatter**: Formats raw gRPC transaction data
- **SolanaEventParser**: Parses CPI events from transactions
- **transactionOutput**: Extracts structured data from parsed transactions
- **getBondingCurveAddress**: Fetches SOL balance for bonding curves

## Data Flow

1. **Stream Setup**: Each monitor establishes a gRPC connection to Yellowstone
2. **Filter Application**: Monitors subscribe to specific data types (transactions/accounts)
3. **Data Processing**: Raw data is parsed using Anchor IDLs and custom parsers
4. **Analysis**: Extracted data is analyzed for specific patterns and metrics
5. **Output**: Formatted results are logged or sent to downstream systems

## Integration with Existing System

These monitors can be integrated with your existing Megatron V2 system by:

1. Storing parsed data in your database
2. Triggering trading strategies based on progress thresholds
3. Alerting when tokens approach graduation
4. Feeding data into your ML prediction engine

## Next Steps

1. Implement error handling and reconnection logic
2. Add database persistence for historical analysis
3. Create aggregated metrics dashboards
4. Integrate with trading execution engine
5. Add webhook notifications for key events