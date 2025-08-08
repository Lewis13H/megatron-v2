# Phase 2: PnL Calculation Engine (Week 2-3)

## Overview
The second phase implements a comprehensive profit and loss (PnL) calculation engine that tracks wallet performance across all trades. This engine calculates both realized and unrealized profits, maintains position histories, and provides the foundation for wallet scoring based on profitability.

## Objectives
1. Track all buy/sell transactions per wallet
2. Calculate realized PnL for closed positions
3. Calculate unrealized PnL for open positions
4. Maintain accurate position tracking with entry/exit points
5. Handle complex scenarios (partial sells, DCA, multiple entries)
6. Store historical PnL data for trend analysis

## Technical Architecture

### 2.1 PnL Calculation Core

```typescript
// src/wallet-tracker/pnl/pnl-calculator.ts

interface PnLCalculator {
  calculateRealizedPnL(position: Position): RealizedPnL;
  calculateUnrealizedPnL(position: Position, currentPrice: number): UnrealizedPnL;
  calculateTotalPnL(wallet: WalletAddress): TotalPnL;
  calculateROI(position: Position): number;
  calculateMultiple(position: Position): number;
}

interface Position {
  wallet_address: string;
  token_mint: string;
  entries: TradeEntry[];
  exits: TradeExit[];
  current_balance: number;
  avg_entry_price: number;
  avg_exit_price: number;
  total_invested: number;
  total_returned: number;
}

interface RealizedPnL {
  sol_profit: number;
  usd_profit: number;
  roi_percentage: number;
  multiple: number;
  hold_duration_minutes: number;
}

interface UnrealizedPnL {
  sol_profit: number;
  usd_profit: number;
  current_value_sol: number;
  current_value_usd: number;
  roi_percentage: number;
  multiple: number;
}

class PnLEngine implements PnLCalculator {
  calculateRealizedPnL(position: Position): RealizedPnL {
    // FIFO (First In, First Out) method for matching buys and sells
    const matched = this.matchTradesFIFO(position.entries, position.exits);
    
    let totalSolProfit = 0;
    let totalUsdProfit = 0;
    let totalHoldTime = 0;
    let tradeCount = 0;
    
    for (const match of matched) {
      const entryValue = match.entry.amount * match.entry.price;
      const exitValue = match.exit.amount * match.exit.price;
      const solProfit = exitValue - entryValue;
      
      // Get historical USD prices
      const entryUsdPrice = await this.getHistoricalSolPrice(match.entry.timestamp);
      const exitUsdPrice = await this.getHistoricalSolPrice(match.exit.timestamp);
      
      const usdProfit = (exitValue * exitUsdPrice) - (entryValue * entryUsdPrice);
      
      totalSolProfit += solProfit;
      totalUsdProfit += usdProfit;
      
      // Calculate hold time
      const holdTime = match.exit.timestamp - match.entry.timestamp;
      totalHoldTime += holdTime;
      tradeCount++;
    }
    
    const avgHoldTime = tradeCount > 0 ? totalHoldTime / tradeCount : 0;
    const roi = (totalSolProfit / position.total_invested) * 100;
    const multiple = position.total_returned / position.total_invested;
    
    return {
      sol_profit: totalSolProfit,
      usd_profit: totalUsdProfit,
      roi_percentage: roi,
      multiple: multiple,
      hold_duration_minutes: avgHoldTime / 60000
    };
  }
  
  calculateUnrealizedPnL(position: Position, currentPrice: number): UnrealizedPnL {
    const currentValueSol = position.current_balance * currentPrice;
    const currentSolPrice = await this.getCurrentSolPrice();
    const currentValueUsd = currentValueSol * currentSolPrice;
    
    // Calculate cost basis for remaining tokens
    const costBasis = this.calculateCostBasis(position);
    
    const unrealizedSolProfit = currentValueSol - costBasis;
    const unrealizedUsdProfit = currentValueUsd - (costBasis * currentSolPrice);
    
    const roi = (unrealizedSolProfit / costBasis) * 100;
    const multiple = currentValueSol / costBasis;
    
    return {
      sol_profit: unrealizedSolProfit,
      usd_profit: unrealizedUsdProfit,
      current_value_sol: currentValueSol,
      current_value_usd: currentValueUsd,
      roi_percentage: roi,
      multiple: multiple
    };
  }
  
  private matchTradesFIFO(entries: TradeEntry[], exits: TradeExit[]): MatchedTrade[] {
    const matched: MatchedTrade[] = [];
    const entryQueue = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    const exitQueue = [...exits].sort((a, b) => a.timestamp - b.timestamp);
    
    let currentEntry = entryQueue.shift();
    let currentExit = exitQueue.shift();
    
    while (currentEntry && currentExit) {
      const matchAmount = Math.min(currentEntry.remaining, currentExit.remaining);
      
      matched.push({
        entry: {
          ...currentEntry,
          amount: matchAmount
        },
        exit: {
          ...currentExit,
          amount: matchAmount
        }
      });
      
      currentEntry.remaining -= matchAmount;
      currentExit.remaining -= matchAmount;
      
      if (currentEntry.remaining === 0) {
        currentEntry = entryQueue.shift();
      }
      if (currentExit.remaining === 0) {
        currentExit = exitQueue.shift();
      }
    }
    
    return matched;
  }
}
```

### 2.2 Position Tracking System

```typescript
// src/wallet-tracker/pnl/position-tracker.ts

interface PositionTracker {
  openPosition(trade: BuyTrade): Promise<void>;
  updatePosition(trade: Trade): Promise<void>;
  closePosition(trade: SellTrade): Promise<void>;
  getPosition(wallet: string, token: string): Promise<Position>;
  getAllPositions(wallet: string): Promise<Position[]>;
}

class PositionManager implements PositionTracker {
  async openPosition(trade: BuyTrade): Promise<void> {
    // Check if position exists
    let position = await this.getPosition(trade.wallet, trade.token);
    
    if (!position) {
      // Create new position
      position = {
        wallet_address: trade.wallet,
        token_mint: trade.token,
        entries: [],
        exits: [],
        current_balance: 0,
        avg_entry_price: 0,
        avg_exit_price: 0,
        total_invested: 0,
        total_returned: 0,
        first_entry_time: trade.timestamp,
        last_update_time: trade.timestamp,
        is_graduated: trade.is_graduated_token,
        status: 'open'
      };
    }
    
    // Add entry to position
    position.entries.push({
      transaction_hash: trade.signature,
      amount: trade.tokenAmount,
      price: trade.price,
      sol_amount: trade.solAmount,
      timestamp: trade.timestamp,
      remaining: trade.tokenAmount // For FIFO matching
    });
    
    // Update position metrics
    position.current_balance += trade.tokenAmount;
    position.total_invested += trade.solAmount;
    
    // Recalculate average entry price
    position.avg_entry_price = this.calculateWeightedAverage(position.entries);
    
    await this.savePosition(position);
  }
  
  async updatePosition(trade: Trade): Promise<void> {
    const position = await this.getPosition(trade.wallet, trade.token);
    
    if (!position) {
      throw new Error(`No position found for ${trade.wallet} in ${trade.token}`);
    }
    
    if (trade.type === 'buy') {
      await this.handleBuy(position, trade);
    } else if (trade.type === 'sell') {
      await this.handleSell(position, trade);
    }
    
    // Update last activity
    position.last_update_time = trade.timestamp;
    
    // Check if position is closed
    if (position.current_balance === 0) {
      position.status = 'closed';
      position.closed_at = trade.timestamp;
    }
    
    await this.savePosition(position);
  }
  
  private async handleSell(position: Position, trade: SellTrade): Promise<void> {
    // Add exit to position
    position.exits.push({
      transaction_hash: trade.signature,
      amount: trade.tokenAmount,
      price: trade.price,
      sol_amount: trade.solAmount,
      timestamp: trade.timestamp,
      remaining: trade.tokenAmount
    });
    
    // Update position metrics
    position.current_balance -= trade.tokenAmount;
    position.total_returned += trade.solAmount;
    
    // Recalculate average exit price
    if (position.exits.length > 0) {
      position.avg_exit_price = this.calculateWeightedAverage(position.exits);
    }
    
    // Calculate realized PnL for this sell
    const pnlEngine = new PnLEngine();
    const realizedPnL = pnlEngine.calculateRealizedPnL(position);
    
    // Store PnL snapshot
    await this.savePnLSnapshot({
      wallet_address: position.wallet_address,
      token_mint: position.token_mint,
      snapshot_type: 'sell',
      realized_pnl_sol: realizedPnL.sol_profit,
      realized_pnl_usd: realizedPnL.usd_profit,
      position_balance: position.current_balance,
      timestamp: trade.timestamp
    });
  }
  
  private calculateWeightedAverage(trades: Array<{amount: number, price: number}>): number {
    let totalValue = 0;
    let totalAmount = 0;
    
    for (const trade of trades) {
      totalValue += trade.amount * trade.price;
      totalAmount += trade.amount;
    }
    
    return totalAmount > 0 ? totalValue / totalAmount : 0;
  }
}
```

### 2.3 Database Schema for PnL Tracking

```sql
-- Migration: 002_create_pnl_tables.sql

-- Position tracking table
CREATE TABLE IF NOT EXISTS wallet_positions (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  
  -- Position metrics
  current_balance DECIMAL(20, 6) DEFAULT 0,
  avg_entry_price DECIMAL(20, 12),
  avg_exit_price DECIMAL(20, 12),
  total_invested_sol DECIMAL(20, 9) DEFAULT 0,
  total_returned_sol DECIMAL(20, 9) DEFAULT 0,
  
  -- PnL metrics
  realized_pnl_sol DECIMAL(20, 9) DEFAULT 0,
  realized_pnl_usd DECIMAL(20, 2) DEFAULT 0,
  unrealized_pnl_sol DECIMAL(20, 9) DEFAULT 0,
  unrealized_pnl_usd DECIMAL(20, 2) DEFAULT 0,
  
  -- Performance metrics
  roi_percentage DECIMAL(10, 2),
  multiple DECIMAL(10, 4),
  win_loss_ratio DECIMAL(10, 4),
  
  -- Timing
  first_entry_time TIMESTAMP,
  last_exit_time TIMESTAMP,
  avg_hold_time_minutes INTEGER,
  
  -- Status
  status VARCHAR(20) DEFAULT 'open', -- 'open', 'closed', 'partial'
  is_graduated BOOLEAN DEFAULT FALSE,
  graduation_entry_timing INTEGER, -- minutes before graduation
  
  -- Metadata
  entry_count INTEGER DEFAULT 0,
  exit_count INTEGER DEFAULT 0,
  last_calculated_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  UNIQUE(wallet_address, token_mint),
  FOREIGN KEY (wallet_address) REFERENCES wallet_traders(wallet_address)
);

-- Indexes for performance
CREATE INDEX idx_positions_wallet ON wallet_positions(wallet_address);
CREATE INDEX idx_positions_token ON wallet_positions(token_mint);
CREATE INDEX idx_positions_pnl ON wallet_positions(realized_pnl_sol DESC);
CREATE INDEX idx_positions_status ON wallet_positions(status);

-- Trade entries and exits
CREATE TABLE IF NOT EXISTS position_trades (
  id SERIAL PRIMARY KEY,
  position_id INTEGER NOT NULL,
  wallet_address VARCHAR(44) NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  
  -- Trade details
  trade_type VARCHAR(10) NOT NULL, -- 'entry' or 'exit'
  transaction_hash VARCHAR(88) NOT NULL,
  token_amount DECIMAL(20, 6) NOT NULL,
  sol_amount DECIMAL(20, 9) NOT NULL,
  price_per_token DECIMAL(20, 12) NOT NULL,
  
  -- USD values at time of trade
  sol_price_usd DECIMAL(10, 4),
  trade_value_usd DECIMAL(20, 2),
  
  -- Context
  market_cap_at_trade DECIMAL(20, 2),
  block_time TIMESTAMP NOT NULL,
  matched_amount DECIMAL(20, 6) DEFAULT 0, -- For FIFO matching
  
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  FOREIGN KEY (position_id) REFERENCES wallet_positions(id),
  FOREIGN KEY (wallet_address) REFERENCES wallet_traders(wallet_address)
);

CREATE INDEX idx_trades_position ON position_trades(position_id);
CREATE INDEX idx_trades_wallet ON position_trades(wallet_address);
CREATE INDEX idx_trades_type ON position_trades(trade_type);
CREATE INDEX idx_trades_time ON position_trades(block_time);

-- PnL snapshots for historical tracking
CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) NOT NULL,
  token_mint VARCHAR(44),
  
  -- Snapshot data
  snapshot_type VARCHAR(20) NOT NULL, -- 'daily', 'sell', 'graduation', 'hourly'
  snapshot_timestamp TIMESTAMP NOT NULL,
  
  -- PnL at snapshot time
  total_realized_pnl_sol DECIMAL(20, 9),
  total_realized_pnl_usd DECIMAL(20, 2),
  total_unrealized_pnl_sol DECIMAL(20, 9),
  total_unrealized_pnl_usd DECIMAL(20, 2),
  
  -- Portfolio metrics
  open_positions_count INTEGER,
  closed_positions_count INTEGER,
  total_invested_sol DECIMAL(20, 9),
  current_portfolio_value_sol DECIMAL(20, 9),
  
  -- Performance metrics
  win_rate DECIMAL(5, 2),
  avg_roi DECIMAL(10, 2),
  best_trade_roi DECIMAL(10, 2),
  worst_trade_roi DECIMAL(10, 2),
  
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  FOREIGN KEY (wallet_address) REFERENCES wallet_traders(wallet_address)
);

CREATE INDEX idx_snapshots_wallet ON pnl_snapshots(wallet_address);
CREATE INDEX idx_snapshots_time ON pnl_snapshots(snapshot_timestamp DESC);
CREATE INDEX idx_snapshots_type ON pnl_snapshots(snapshot_type);
```

### 2.4 Complex Scenario Handlers

```typescript
// src/wallet-tracker/pnl/scenario-handlers.ts

class ComplexScenarioHandler {
  
  // Handle Dollar Cost Averaging (DCA)
  async handleDCA(wallet: string, token: string, trades: Trade[]): Promise<Position> {
    const position = await this.positionManager.getPosition(wallet, token);
    
    // Group trades by time windows (e.g., within 5 minutes)
    const dcaGroups = this.groupTradesByTimeWindow(trades, 5 * 60 * 1000);
    
    for (const group of dcaGroups) {
      // Calculate weighted average for each DCA batch
      const avgPrice = this.calculateWeightedAverage(group);
      const totalAmount = group.reduce((sum, t) => sum + t.amount, 0);
      const totalSol = group.reduce((sum, t) => sum + t.solAmount, 0);
      
      // Create consolidated entry
      const dcaEntry = {
        type: 'dca_batch',
        trades: group.length,
        amount: totalAmount,
        avg_price: avgPrice,
        sol_amount: totalSol,
        timestamp: group[0].timestamp
      };
      
      await this.positionManager.addDCAEntry(position, dcaEntry);
    }
    
    return position;
  }
  
  // Handle Partial Sells
  async handlePartialSell(position: Position, sellTrade: SellTrade): Promise<PnLResult> {
    // Calculate what percentage of position is being sold
    const sellPercentage = sellTrade.tokenAmount / position.current_balance;
    
    // Calculate realized PnL for partial sell
    const partialCostBasis = position.total_invested * sellPercentage;
    const sellValue = sellTrade.solAmount;
    const realizedProfit = sellValue - partialCostBasis;
    
    // Update position
    position.current_balance -= sellTrade.tokenAmount;
    position.total_invested -= partialCostBasis;
    position.total_returned += sellValue;
    position.realized_pnl_sol += realizedProfit;
    
    // Calculate remaining unrealized PnL
    const currentPrice = await this.getCurrentPrice(position.token_mint);
    const remainingValue = position.current_balance * currentPrice;
    const remainingCostBasis = position.total_invested;
    position.unrealized_pnl_sol = remainingValue - remainingCostBasis;
    
    return {
      realized: realizedProfit,
      unrealized: position.unrealized_pnl_sol,
      total: realizedProfit + position.unrealized_pnl_sol
    };
  }
  
  // Handle Token Swaps (sell one token for another)
  async handleTokenSwap(
    wallet: string,
    fromToken: string,
    toToken: string,
    swapData: SwapData
  ): Promise<void> {
    // Close position in fromToken
    const fromPosition = await this.positionManager.getPosition(wallet, fromToken);
    const sellValue = swapData.fromAmount * swapData.fromPrice;
    
    await this.positionManager.closePosition({
      wallet,
      token: fromToken,
      tokenAmount: swapData.fromAmount,
      solAmount: sellValue,
      price: swapData.fromPrice,
      timestamp: swapData.timestamp
    });
    
    // Open position in toToken
    const buyValue = swapData.toAmount * swapData.toPrice;
    
    await this.positionManager.openPosition({
      wallet,
      token: toToken,
      tokenAmount: swapData.toAmount,
      solAmount: buyValue,
      price: swapData.toPrice,
      timestamp: swapData.timestamp,
      linkedFrom: fromToken // Track swap chain
    });
  }
  
  // Handle Rug Pulls / Total Loss
  async handleRugPull(wallet: string, token: string): Promise<void> {
    const position = await this.positionManager.getPosition(wallet, token);
    
    if (position && position.current_balance > 0) {
      // Mark as total loss
      position.status = 'rugged';
      position.realized_pnl_sol = -position.total_invested;
      position.realized_pnl_usd = -position.total_invested * (await this.getCurrentSolPrice());
      position.unrealized_pnl_sol = 0;
      position.unrealized_pnl_usd = 0;
      position.rug_detected_at = new Date();
      
      await this.positionManager.savePosition(position);
      
      // Update wallet stats
      await this.updateWalletRugStats(wallet);
    }
  }
}
```

### 2.5 PnL Aggregation & Analytics

```typescript
// src/wallet-tracker/pnl/pnl-aggregator.ts

class PnLAggregator {
  
  // Calculate total wallet PnL across all positions
  async calculateWalletPnL(wallet: string): Promise<WalletPnL> {
    const positions = await this.positionManager.getAllPositions(wallet);
    
    let totalRealizedSol = 0;
    let totalRealizedUsd = 0;
    let totalUnrealizedSol = 0;
    let totalUnrealizedUsd = 0;
    let totalInvested = 0;
    let totalReturned = 0;
    
    const openPositions: Position[] = [];
    const closedPositions: Position[] = [];
    const winningTrades: Position[] = [];
    const losingTrades: Position[] = [];
    
    for (const position of positions) {
      totalRealizedSol += position.realized_pnl_sol;
      totalRealizedUsd += position.realized_pnl_usd;
      totalInvested += position.total_invested_sol;
      totalReturned += position.total_returned_sol;
      
      if (position.status === 'open') {
        openPositions.push(position);
        // Calculate current unrealized PnL
        const currentPrice = await this.getCurrentPrice(position.token_mint);
        const unrealized = this.pnlEngine.calculateUnrealizedPnL(position, currentPrice);
        totalUnrealizedSol += unrealized.sol_profit;
        totalUnrealizedUsd += unrealized.usd_profit;
      } else {
        closedPositions.push(position);
        if (position.realized_pnl_sol > 0) {
          winningTrades.push(position);
        } else {
          losingTrades.push(position);
        }
      }
    }
    
    const winRate = closedPositions.length > 0 
      ? (winningTrades.length / closedPositions.length) * 100 
      : 0;
    
    const avgWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, p) => sum + p.realized_pnl_sol, 0) / winningTrades.length
      : 0;
    
    const avgLoss = losingTrades.length > 0
      ? losingTrades.reduce((sum, p) => sum + p.realized_pnl_sol, 0) / losingTrades.length
      : 0;
    
    const profitFactor = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : avgWin;
    
    return {
      wallet_address: wallet,
      total_realized_pnl_sol: totalRealizedSol,
      total_realized_pnl_usd: totalRealizedUsd,
      total_unrealized_pnl_sol: totalUnrealizedSol,
      total_unrealized_pnl_usd: totalUnrealizedUsd,
      total_pnl_sol: totalRealizedSol + totalUnrealizedSol,
      total_pnl_usd: totalRealizedUsd + totalUnrealizedUsd,
      total_invested: totalInvested,
      total_returned: totalReturned,
      roi_percentage: totalInvested > 0 ? ((totalReturned - totalInvested) / totalInvested) * 100 : 0,
      win_rate: winRate,
      profit_factor: profitFactor,
      open_positions: openPositions.length,
      closed_positions: closedPositions.length,
      winning_trades: winningTrades.length,
      losing_trades: losingTrades.length,
      avg_win_sol: avgWin,
      avg_loss_sol: avgLoss,
      best_trade: this.findBestTrade(positions),
      worst_trade: this.findWorstTrade(positions),
      calculated_at: new Date()
    };
  }
  
  // Generate PnL time series for charting
  async generatePnLTimeSeries(
    wallet: string,
    interval: 'hourly' | 'daily' | 'weekly'
  ): Promise<PnLTimeSeries[]> {
    const snapshots = await this.db.query(`
      SELECT 
        date_trunc($1, snapshot_timestamp) as period,
        AVG(total_realized_pnl_sol) as avg_realized_sol,
        AVG(total_unrealized_pnl_sol) as avg_unrealized_sol,
        AVG(total_realized_pnl_usd) as avg_realized_usd,
        AVG(total_unrealized_pnl_usd) as avg_unrealized_usd,
        MAX(open_positions_count) as max_open_positions,
        AVG(win_rate) as avg_win_rate
      FROM pnl_snapshots
      WHERE wallet_address = $2
        AND snapshot_timestamp > NOW() - INTERVAL '30 days'
      GROUP BY period
      ORDER BY period ASC
    `, [interval, wallet]);
    
    return snapshots.map(s => ({
      period: s.period,
      realized_pnl_sol: s.avg_realized_sol,
      unrealized_pnl_sol: s.avg_unrealized_sol,
      total_pnl_sol: s.avg_realized_sol + s.avg_unrealized_sol,
      realized_pnl_usd: s.avg_realized_usd,
      unrealized_pnl_usd: s.avg_unrealized_usd,
      total_pnl_usd: s.avg_realized_usd + s.avg_unrealized_usd,
      open_positions: s.max_open_positions,
      win_rate: s.avg_win_rate
    }));
  }
  
  // Calculate wallet performance metrics
  async calculatePerformanceMetrics(wallet: string): Promise<PerformanceMetrics> {
    const pnl = await this.calculateWalletPnL(wallet);
    const positions = await this.positionManager.getAllPositions(wallet);
    
    // Calculate Sharpe Ratio (risk-adjusted returns)
    const returns = positions.map(p => p.realized_pnl_sol / p.total_invested_sol);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdDev = this.calculateStandardDeviation(returns);
    const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;
    
    // Calculate Max Drawdown
    const cumulativeReturns = this.calculateCumulativeReturns(positions);
    const maxDrawdown = this.calculateMaxDrawdown(cumulativeReturns);
    
    // Calculate other metrics
    const avgHoldTime = positions.reduce((sum, p) => sum + (p.avg_hold_time_minutes || 0), 0) / positions.length;
    const graduatedTokensTraded = positions.filter(p => p.is_graduated).length;
    const graduatedWinRate = this.calculateGraduatedWinRate(positions);
    
    return {
      total_pnl_sol: pnl.total_pnl_sol,
      total_pnl_usd: pnl.total_pnl_usd,
      roi_percentage: pnl.roi_percentage,
      win_rate: pnl.win_rate,
      profit_factor: pnl.profit_factor,
      sharpe_ratio: sharpeRatio,
      max_drawdown: maxDrawdown,
      avg_hold_time_minutes: avgHoldTime,
      graduated_tokens_traded: graduatedTokensTraded,
      graduated_win_rate: graduatedWinRate,
      total_trades: positions.length,
      avg_position_size_sol: pnl.total_invested / positions.length,
      best_month_pnl: await this.getBestMonthPnL(wallet),
      worst_month_pnl: await this.getWorstMonthPnL(wallet),
      consecutive_wins: this.calculateConsecutiveWins(positions),
      consecutive_losses: this.calculateConsecutiveLosses(positions)
    };
  }
}
```

### 2.6 Batch Processing & Optimization

```typescript
// src/wallet-tracker/pnl/batch-processor.ts

class PnLBatchProcessor {
  private queue: Bull.Queue;
  private batchSize: number = 100;
  
  constructor() {
    this.queue = new Bull('pnl-calculation', {
      redis: {
        host: 'localhost',
        port: 6379
      }
    });
    
    this.setupWorkers();
  }
  
  private setupWorkers() {
    // Process wallet PnL calculations
    this.queue.process('calculate-wallet-pnl', 10, async (job) => {
      const { walletAddress } = job.data;
      
      try {
        // Calculate PnL
        const aggregator = new PnLAggregator();
        const pnl = await aggregator.calculateWalletPnL(walletAddress);
        
        // Store results
        await this.storePnLResults(walletAddress, pnl);
        
        // Create snapshot
        await this.createPnLSnapshot(walletAddress, pnl);
        
        // Update wallet trader record
        await this.updateWalletTrader(walletAddress, pnl);
        
        return { success: true, wallet: walletAddress, pnl: pnl.total_pnl_sol };
      } catch (error) {
        console.error(`PnL calculation failed for ${walletAddress}:`, error);
        throw error;
      }
    });
    
    // Process position updates
    this.queue.process('update-position', 20, async (job) => {
      const { trade } = job.data;
      
      const positionManager = new PositionManager();
      await positionManager.updatePosition(trade);
      
      // Trigger PnL recalculation for wallet
      await this.queue.add('calculate-wallet-pnl', {
        walletAddress: trade.wallet
      }, {
        delay: 1000 // Delay to batch multiple updates
      });
      
      return { success: true, position_updated: true };
    });
  }
  
  async processAllWallets(): Promise<void> {
    // Get all wallets that need PnL calculation
    const wallets = await this.db.query(`
      SELECT DISTINCT wallet_address 
      FROM wallet_traders 
      WHERE last_activity_at > NOW() - INTERVAL '30 days'
      ORDER BY total_trades DESC
    `);
    
    console.log(`Processing PnL for ${wallets.length} wallets`);
    
    // Add to queue in batches
    for (let i = 0; i < wallets.length; i += this.batchSize) {
      const batch = wallets.slice(i, i + this.batchSize);
      
      const jobs = batch.map(w => ({
        name: 'calculate-wallet-pnl',
        data: { walletAddress: w.wallet_address },
        opts: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          }
        }
      }));
      
      await this.queue.addBulk(jobs);
      
      console.log(`Added batch ${i / this.batchSize + 1} to queue`);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  async updateWalletTrader(wallet: string, pnl: WalletPnL): Promise<void> {
    await this.db.query(`
      UPDATE wallet_traders
      SET 
        total_pnl_sol = $2,
        total_pnl_usd = $3,
        win_rate = $4,
        avg_hold_time_minutes = $5,
        last_activity_at = NOW(),
        updated_at = NOW()
      WHERE wallet_address = $1
    `, [
      wallet,
      pnl.total_pnl_sol,
      pnl.total_pnl_usd,
      pnl.win_rate,
      pnl.avg_hold_time_minutes
    ]);
  }
}
```

## Implementation Steps

### Step 1: Database Setup
```bash
# Run PnL tables migration
npx ts-node src/database/migrations/002_create_pnl_tables.sql

# Create indexes for performance
npx ts-node src/wallet-tracker/scripts/create-pnl-indexes.ts

# Verify schema
npx ts-node src/wallet-tracker/scripts/verify-pnl-schema.ts
```

### Step 2: Initialize PnL Engine
```typescript
// src/wallet-tracker/scripts/initialize-pnl-engine.ts

async function initializePnLEngine() {
  console.log('Initializing PnL calculation engine...');
  
  // Step 1: Load all historical trades
  const trades = await loadHistoricalTrades();
  console.log(`Loaded ${trades.length} historical trades`);
  
  // Step 2: Group trades by wallet and token
  const groupedTrades = groupTradesByWalletAndToken(trades);
  console.log(`Found ${Object.keys(groupedTrades).length} unique positions`);
  
  // Step 3: Create initial positions
  const positionManager = new PositionManager();
  let created = 0;
  
  for (const [key, trades] of Object.entries(groupedTrades)) {
    const [wallet, token] = key.split(':');
    
    // Sort trades chronologically
    const sortedTrades = trades.sort((a, b) => a.timestamp - b.timestamp);
    
    // Process each trade
    for (const trade of sortedTrades) {
      if (trade.type === 'buy') {
        await positionManager.openPosition(trade);
      } else {
        await positionManager.updatePosition(trade);
      }
    }
    
    created++;
    if (created % 100 === 0) {
      console.log(`Created ${created} positions`);
    }
  }
  
  console.log(`Successfully created ${created} positions`);
}

initializePnLEngine().catch(console.error);
```

### Step 3: Run PnL Calculations
```typescript
// src/wallet-tracker/scripts/run-pnl-calculations.ts

async function runPnLCalculations() {
  const processor = new PnLBatchProcessor();
  
  // Start processing queue
  console.log('Starting PnL batch processor...');
  
  // Process all wallets
  await processor.processAllWallets();
  
  // Monitor progress
  const interval = setInterval(async () => {
    const stats = await processor.getQueueStats();
    console.log(`Queue stats: ${JSON.stringify(stats)}`);
    
    if (stats.waiting === 0 && stats.active === 0) {
      clearInterval(interval);
      console.log('PnL calculations complete!');
      
      // Generate summary report
      await generatePnLSummaryReport();
    }
  }, 5000);
}

async function generatePnLSummaryReport() {
  const report = await db.query(`
    SELECT 
      COUNT(*) as total_wallets,
      COUNT(CASE WHEN total_pnl_sol > 0 THEN 1 END) as profitable_wallets,
      AVG(total_pnl_sol) as avg_pnl_sol,
      MAX(total_pnl_sol) as max_pnl_sol,
      MIN(total_pnl_sol) as min_pnl_sol,
      AVG(win_rate) as avg_win_rate,
      SUM(total_pnl_sol) as total_system_pnl
    FROM wallet_traders
    WHERE total_pnl_sol IS NOT NULL
  `);
  
  console.log('PnL Summary Report:', report[0]);
}

runPnLCalculations().catch(console.error);
```

### Step 4: Create Monitoring Dashboard
```typescript
// src/wallet-tracker/api/pnl-endpoints.ts

router.get('/api/wallets/:address/pnl', async (req, res) => {
  const { address } = req.params;
  const { interval = 'daily' } = req.query;
  
  const aggregator = new PnLAggregator();
  
  // Get current PnL
  const currentPnL = await aggregator.calculateWalletPnL(address);
  
  // Get time series
  const timeSeries = await aggregator.generatePnLTimeSeries(address, interval);
  
  // Get performance metrics
  const metrics = await aggregator.calculatePerformanceMetrics(address);
  
  res.json({
    current: currentPnL,
    timeSeries,
    metrics
  });
});

router.get('/api/wallets/:address/positions', async (req, res) => {
  const { address } = req.params;
  const { status = 'all' } = req.query;
  
  const positions = await db.query(`
    SELECT * FROM wallet_positions
    WHERE wallet_address = $1
    ${status !== 'all' ? 'AND status = $2' : ''}
    ORDER BY updated_at DESC
  `, status !== 'all' ? [address, status] : [address]);
  
  res.json(positions);
});
```

## Performance Optimization

### 1. Materialized Views for Fast Queries
```sql
-- Create materialized view for wallet PnL summary
CREATE MATERIALIZED VIEW wallet_pnl_summary AS
SELECT 
  wallet_address,
  SUM(realized_pnl_sol) as total_realized_pnl,
  SUM(unrealized_pnl_sol) as total_unrealized_pnl,
  COUNT(CASE WHEN status = 'open' THEN 1 END) as open_positions,
  COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed_positions,
  AVG(roi_percentage) as avg_roi,
  MAX(updated_at) as last_updated
FROM wallet_positions
GROUP BY wallet_address;

CREATE UNIQUE INDEX ON wallet_pnl_summary(wallet_address);

-- Refresh periodically
REFRESH MATERIALIZED VIEW CONCURRENTLY wallet_pnl_summary;
```

### 2. Caching Strategy
```typescript
class PnLCache {
  private redis: Redis;
  private ttl: number = 300; // 5 minutes
  
  async getCachedPnL(wallet: string): Promise<WalletPnL | null> {
    const cached = await this.redis.get(`pnl:${wallet}`);
    return cached ? JSON.parse(cached) : null;
  }
  
  async setCachedPnL(wallet: string, pnl: WalletPnL): Promise<void> {
    await this.redis.setex(
      `pnl:${wallet}`,
      this.ttl,
      JSON.stringify(pnl)
    );
  }
}
```

## Monitoring & Validation

### PnL Validation Checks
```typescript
class PnLValidator {
  async validatePnLCalculations(): Promise<ValidationReport> {
    const checks = [];
    
    // Check 1: Realized PnL = Sum of closed trades
    const realizedCheck = await this.validateRealizedPnL();
    checks.push(realizedCheck);
    
    // Check 2: Position balances match trade history
    const balanceCheck = await this.validatePositionBalances();
    checks.push(balanceCheck);
    
    // Check 3: No negative token balances
    const negativeCheck = await this.checkNegativeBalances();
    checks.push(negativeCheck);
    
    // Check 4: ROI calculations are correct
    const roiCheck = await this.validateROICalculations();
    checks.push(roiCheck);
    
    return {
      passed: checks.every(c => c.passed),
      checks
    };
  }
}
```

## Success Metrics

### Target Metrics
- Calculate PnL for 100,000+ wallets
- Process 1M+ positions
- Calculation accuracy: 99.9%
- Processing speed: 1000 wallets/minute
- Cache hit rate: >80%
- API response time: <100ms

### Quality Metrics
- PnL calculation accuracy: ±0.01 SOL
- Position tracking accuracy: 100%
- FIFO matching correctness: 100%
- Historical price accuracy: ±1%

## Deliverables

1. **PnL Engine**: Complete calculation system with FIFO matching
2. **Position Tracking**: Accurate position management for all wallets
3. **Database Tables**: All PnL tracking tables populated
4. **API Endpoints**: RESTful API for PnL data access
5. **Performance Metrics**: Benchmarks and optimization report

## Next Phase Prerequisites

Before moving to Phase 3 (Scoring System), ensure:
- [ ] PnL calculated for all tracked wallets
- [ ] Position accuracy validated
- [ ] Performance benchmarks met
- [ ] API endpoints tested
- [ ] Caching layer operational
- [ ] Monitoring dashboard functional