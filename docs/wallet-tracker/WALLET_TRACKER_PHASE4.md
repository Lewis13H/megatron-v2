# Phase 4: Real-time Monitoring (Week 4-5)

## Overview
The fourth phase implements real-time monitoring of successful wallets, generating smart money signals when high-scoring traders buy tokens, and integrating these signals into the Megatron token scoring system. This creates a live feedback loop where successful trader actions directly influence token evaluation.

## Objectives
1. Monitor transactions from high-scoring wallets in real-time
2. Generate smart money signals for tokens being bought by successful traders
3. Update wallet scores dynamically based on new trades
4. Track performance of smart money signals
5. Create alert system for significant smart money movements
6. Build real-time dashboard for monitoring activity

## Technical Architecture

### 4.1 Real-time Transaction Monitor

```typescript
// src/wallet-tracker/monitoring/realtime-monitor.ts

interface RealtimeMonitorConfig {
  smartMoneyThreshold: number;     // Minimum wallet score (default: 700)
  signalThreshold: number;          // Min wallets for signal (default: 3)
  updateInterval: number;           // MS between updates (default: 1000)
  batchSize: number;                // Transactions per batch (default: 100)
}

class SmartMoneyMonitor {
  private config: RealtimeMonitorConfig;
  private trackedWallets: Set<string>;
  private activeSignals: Map<string, SmartMoneySignal>;
  private grpcClient: YellowstoneGrpc;
  
  constructor(config: RealtimeMonitorConfig) {
    this.config = config;
    this.trackedWallets = new Set();
    this.activeSignals = new Map();
    
    this.initializeGrpcStream();
    this.loadTrackedWallets();
  }
  
  private async initializeGrpcStream() {
    // Connect to Yellowstone gRPC
    this.grpcClient = new YellowstoneGrpc(
      process.env.GRPC_URL!,
      process.env.X_TOKEN!
    );
    
    // Subscribe to transactions from tracked wallets
    const stream = await this.grpcClient.subscribe({
      transactions: {
        smart_money: {
          vote: false,
          failed: false,
          signature: undefined,
          account_include: Array.from(this.trackedWallets),
          account_exclude: [],
          account_required: []
        }
      },
      commitment: CommitmentLevel.CONFIRMED
    });
    
    stream.on('data', async (data) => {
      if (data.transaction) {
        await this.processTransaction(data.transaction);
      }
    });
    
    stream.on('error', (error) => {
      console.error('gRPC stream error:', error);
      this.reconnect();
    });
  }
  
  private async loadTrackedWallets() {
    // Load all smart money wallets
    const wallets = await this.db.query(`
      SELECT wallet_address
      FROM wallet_traders
      WHERE trader_score >= $1
        AND last_activity_at > NOW() - INTERVAL '30 days'
    `, [this.config.smartMoneyThreshold]);
    
    for (const wallet of wallets) {
      this.trackedWallets.add(wallet.wallet_address);
    }
    
    console.log(`Tracking ${this.trackedWallets.size} smart money wallets`);
    
    // Add manually tracked wallets
    await this.loadManuallyTrackedWallets();
  }
  
  private async loadManuallyTrackedWallets() {
    const manualWallets = await this.db.query(`
      SELECT wallet_address
      FROM manual_tracked_wallets
      WHERE priority_level >= 3
    `);
    
    for (const wallet of manualWallets) {
      this.trackedWallets.add(wallet.wallet_address);
    }
  }
  
  private async processTransaction(transaction: SubscribeUpdateTransaction) {
    try {
      // Parse transaction
      const parsed = await this.parseTransaction(transaction);
      
      if (!parsed || !this.isRelevantTransaction(parsed)) {
        return;
      }
      
      // Check if it's a buy transaction
      if (parsed.type === 'buy' && parsed.tokenMint) {
        await this.handleSmartMoneyBuy(parsed);
      }
      
      // Update wallet activity
      await this.updateWalletActivity(parsed.signer, parsed);
      
    } catch (error) {
      console.error('Error processing transaction:', error);
    }
  }
  
  private async handleSmartMoneyBuy(transaction: ParsedTransaction) {
    const wallet = transaction.signer;
    const tokenMint = transaction.tokenMint;
    
    // Get wallet score
    const walletData = await this.getWalletData(wallet);
    
    if (!walletData || walletData.trader_score < this.config.smartMoneyThreshold) {
      return;
    }
    
    // Check if signal already exists for this token
    let signal = this.activeSignals.get(tokenMint);
    
    if (!signal) {
      signal = {
        token_mint: tokenMint,
        smart_wallets: [],
        first_detected_at: new Date(),
        last_updated_at: new Date(),
        total_investment_sol: 0,
        avg_trader_score: 0,
        signal_strength: 0
      };
      this.activeSignals.set(tokenMint, signal);
    }
    
    // Add wallet to signal
    signal.smart_wallets.push({
      address: wallet,
      trader_score: walletData.trader_score,
      investment_size: transaction.solAmount,
      entry_price: transaction.price,
      profit_history: walletData.total_pnl_sol,
      timestamp: new Date()
    });
    
    // Update signal metrics
    signal.total_investment_sol += transaction.solAmount;
    signal.avg_trader_score = this.calculateAvgTraderScore(signal.smart_wallets);
    signal.signal_strength = this.calculateSignalStrength(signal);
    signal.last_updated_at = new Date();
    
    // Emit signal if threshold met
    if (signal.smart_wallets.length >= this.config.signalThreshold) {
      await this.emitSmartMoneySignal(signal);
    }
    
    // Store transaction
    await this.storeSmartMoneyTransaction(transaction, walletData);
  }
  
  private calculateSignalStrength(signal: SmartMoneySignal): number {
    // Factors: number of wallets, average score, total investment
    const walletFactor = Math.min(signal.smart_wallets.length / 10, 1) * 30;
    const scoreFactor = (signal.avg_trader_score / 1000) * 40;
    const investmentFactor = Math.min(signal.total_investment_sol / 500, 1) * 30;
    
    return walletFactor + scoreFactor + investmentFactor;
  }
  
  private async emitSmartMoneySignal(signal: SmartMoneySignal) {
    // Update token wallet score
    await this.updateTokenWalletScore(signal.token_mint, signal);
    
    // Create alert
    await this.createSmartMoneyAlert(signal);
    
    // Emit to websocket subscribers
    this.websocket.emit('smart-money-signal', signal);
    
    // Store signal
    await this.storeSignal(signal);
    
    console.log(`Smart money signal emitted for ${signal.token_mint}`);
    console.log(`  - Wallets: ${signal.smart_wallets.length}`);
    console.log(`  - Avg Score: ${signal.avg_trader_score.toFixed(2)}`);
    console.log(`  - Investment: ${signal.total_investment_sol.toFixed(2)} SOL`);
    console.log(`  - Strength: ${signal.signal_strength.toFixed(2)}/100`);
  }
}
```

### 4.2 Signal Generation & Management

```typescript
// src/wallet-tracker/monitoring/signal-generator.ts

interface SignalGenerator {
  generateSignal(token: string, buyers: SmartWalletBuyer[]): SmartMoneySignal;
  evaluateSignalQuality(signal: SmartMoneySignal): SignalQuality;
  trackSignalPerformance(signal: SmartMoneySignal): Promise<void>;
}

class SmartMoneySignalGenerator implements SignalGenerator {
  private signalHistory: Map<string, SignalPerformance>;
  
  generateSignal(token: string, buyers: SmartWalletBuyer[]): SmartMoneySignal {
    // Calculate wallet score contribution (0-333)
    const walletScore = this.calculateWalletScore(buyers);
    
    // Determine urgency level
    const urgency = this.determineUrgency(buyers);
    
    // Calculate risk assessment
    const risk = this.assessRisk(token, buyers);
    
    return {
      token_mint: token,
      wallet_score: walletScore,
      signal_strength: (walletScore / 333) * 100,
      smart_wallets: buyers,
      urgency_level: urgency,
      risk_assessment: risk,
      generated_at: new Date(),
      metadata: {
        earliest_buy: this.getEarliestBuy(buyers),
        latest_buy: this.getLatestBuy(buyers),
        concentration: this.calculateConcentration(buyers),
        momentum: this.calculateMomentum(buyers)
      }
    };
  }
  
  private calculateWalletScore(buyers: SmartWalletBuyer[]): number {
    // Component 1: Smart Wallet Count (100 points)
    const countScore = this.scoreByCount(buyers.length);
    
    // Component 2: Average Trader Quality (133 points)
    const qualityScore = this.scoreByQuality(buyers);
    
    // Component 3: Total Investment (100 points)
    const investmentScore = this.scoreByInvestment(buyers);
    
    return Math.min(333, countScore + qualityScore + investmentScore);
  }
  
  private determineUrgency(buyers: SmartWalletBuyer[]): 'critical' | 'high' | 'medium' | 'low' {
    // Check time clustering
    const timestamps = buyers.map(b => b.timestamp.getTime());
    const timeSpan = Math.max(...timestamps) - Math.min(...timestamps);
    const avgTimeBetween = timeSpan / buyers.length;
    
    // Multiple high-score wallets buying within minutes = critical
    const highScoreBuyers = buyers.filter(b => b.trader_score > 900);
    
    if (highScoreBuyers.length >= 3 && avgTimeBetween < 5 * 60 * 1000) {
      return 'critical';
    }
    
    if (buyers.length >= 5 && avgTimeBetween < 30 * 60 * 1000) {
      return 'high';
    }
    
    if (buyers.length >= 3) {
      return 'medium';
    }
    
    return 'low';
  }
  
  private assessRisk(token: string, buyers: SmartWalletBuyer[]): RiskAssessment {
    return {
      level: 'medium', // Implement risk calculation
      factors: {
        wallet_diversity: this.calculateDiversity(buyers),
        investment_concentration: this.calculateConcentration(buyers),
        historical_performance: this.getHistoricalPerformance(buyers)
      }
    };
  }
  
  evaluateSignalQuality(signal: SmartMoneySignal): SignalQuality {
    // Evaluate based on historical performance of similar signals
    const similarSignals = this.findSimilarSignals(signal);
    
    if (similarSignals.length === 0) {
      return {
        quality: 'unknown',
        confidence: 0,
        historical_success_rate: 0
      };
    }
    
    const successRate = this.calculateSuccessRate(similarSignals);
    const confidence = this.calculateConfidence(signal, similarSignals);
    
    return {
      quality: successRate > 0.7 ? 'high' : successRate > 0.5 ? 'medium' : 'low',
      confidence,
      historical_success_rate: successRate,
      similar_signals_count: similarSignals.length
    };
  }
  
  async trackSignalPerformance(signal: SmartMoneySignal): Promise<void> {
    // Schedule performance tracking
    const trackingIntervals = [
      5 * 60 * 1000,      // 5 minutes
      30 * 60 * 1000,     // 30 minutes
      2 * 60 * 60 * 1000, // 2 hours
      24 * 60 * 60 * 1000 // 24 hours
    ];
    
    for (const interval of trackingIntervals) {
      setTimeout(async () => {
        await this.measureSignalOutcome(signal, interval);
      }, interval);
    }
  }
  
  private async measureSignalOutcome(signal: SmartMoneySignal, timeElapsed: number) {
    // Get current token price and metrics
    const currentMetrics = await this.getTokenMetrics(signal.token_mint);
    const initialPrice = signal.smart_wallets[0].entry_price;
    
    const priceChange = ((currentMetrics.price - initialPrice) / initialPrice) * 100;
    const volumeIncrease = currentMetrics.volume_24h;
    
    // Store performance snapshot
    await this.db.query(`
      INSERT INTO signal_performance_snapshots (
        signal_id,
        time_elapsed_ms,
        price_change_percent,
        volume_increase,
        token_graduated,
        snapshot_timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      signal.id,
      timeElapsed,
      priceChange,
      volumeIncrease,
      currentMetrics.graduated,
      new Date()
    ]);
    
    // Update signal history
    if (!this.signalHistory.has(signal.token_mint)) {
      this.signalHistory.set(signal.token_mint, {
        signal_id: signal.id,
        outcomes: []
      });
    }
    
    this.signalHistory.get(signal.token_mint)!.outcomes.push({
      time_elapsed: timeElapsed,
      price_change: priceChange,
      success: priceChange > 20 // 20% gain considered success
    });
  }
}
```

### 4.3 Dynamic Score Updates

```typescript
// src/wallet-tracker/monitoring/dynamic-updater.ts

class DynamicScoreUpdater {
  private updateQueue: Bull.Queue;
  private scoreCache: Map<string, CachedScore>;
  
  constructor() {
    this.updateQueue = new Bull('dynamic-score-updates');
    this.scoreCache = new Map();
    this.setupWorkers();
  }
  
  async handleNewTrade(trade: WalletTrade) {
    // Get cached score
    let cachedScore = this.scoreCache.get(trade.wallet_address);
    
    if (!cachedScore || this.isStale(cachedScore)) {
      cachedScore = await this.fetchCurrentScore(trade.wallet_address);
    }
    
    // Quick update based on trade outcome
    const quickUpdate = this.calculateQuickUpdate(cachedScore, trade);
    
    // Update cache
    this.scoreCache.set(trade.wallet_address, {
      ...cachedScore,
      score: quickUpdate.newScore,
      last_updated: new Date()
    });
    
    // Queue full recalculation if significant change
    if (Math.abs(quickUpdate.scoreDelta) > 10) {
      await this.queueFullRecalculation(trade.wallet_address, 'significant_trade');
    }
    
    // Check if wallet crossed smart money threshold
    if (cachedScore.score < 700 && quickUpdate.newScore >= 700) {
      await this.handleNewSmartMoney(trade.wallet_address);
    }
  }
  
  private calculateQuickUpdate(
    currentScore: CachedScore,
    trade: WalletTrade
  ): QuickScoreUpdate {
    let scoreDelta = 0;
    
    // Profitable trade increases score
    if (trade.realized_pnl > 0) {
      // Scale based on profit size
      const profitImpact = Math.min(trade.realized_pnl / 10, 20); // Max 20 points
      scoreDelta += profitImpact;
      
      // Bonus for graduated token
      if (trade.is_graduated_token) {
        scoreDelta += 5;
      }
    } else if (trade.realized_pnl < 0) {
      // Loss decreases score
      const lossImpact = Math.max(trade.realized_pnl / 10, -10); // Max -10 points
      scoreDelta += lossImpact;
    }
    
    // New trade increases activity score slightly
    scoreDelta += 0.5;
    
    return {
      newScore: Math.max(0, Math.min(1000, currentScore.score + scoreDelta)),
      scoreDelta,
      reason: trade.realized_pnl > 0 ? 'profitable_trade' : 'loss_trade'
    };
  }
  
  private async handleNewSmartMoney(walletAddress: string) {
    console.log(`New smart money wallet detected: ${walletAddress}`);
    
    // Add to tracked wallets
    await this.addToTrackedWallets(walletAddress);
    
    // Create alert
    await this.createAlert({
      type: 'new_smart_money',
      wallet_address: walletAddress,
      message: 'Wallet crossed 700 score threshold',
      timestamp: new Date()
    });
    
    // Analyze recent trades for immediate signals
    const recentTrades = await this.getRecentTrades(walletAddress);
    
    for (const trade of recentTrades) {
      if (trade.type === 'buy' && trade.current_balance > 0) {
        // Check if other smart money is in this token
        await this.checkForSignal(trade.token_mint);
      }
    }
  }
  
  async performFullRecalculation(walletAddress: string) {
    const scorer = new WalletScorer();
    const newScore = await scorer.calculateWalletScore(walletAddress);
    
    // Update database
    await this.db.query(`
      UPDATE wallet_traders
      SET 
        trader_score = $2,
        score_updated_at = NOW(),
        percentile_rank = $3
      WHERE wallet_address = $1
    `, [walletAddress, newScore.total_score, newScore.percentile_rank]);
    
    // Update cache
    this.scoreCache.set(walletAddress, {
      score: newScore.total_score,
      percentile: newScore.percentile_rank,
      components: newScore.components,
      last_updated: new Date()
    });
    
    // Check for threshold changes
    await this.checkThresholdChanges(walletAddress, newScore);
  }
  
  private async checkThresholdChanges(
    walletAddress: string,
    newScore: WalletScore
  ) {
    const thresholds = [
      { level: 900, name: 'elite' },
      { level: 800, name: 'expert' },
      { level: 700, name: 'smart_money' },
      { level: 500, name: 'profitable' }
    ];
    
    const previousLevel = await this.getPreviousLevel(walletAddress);
    const newLevel = thresholds.find(t => newScore.total_score >= t.level);
    
    if (newLevel && newLevel.name !== previousLevel) {
      await this.handleLevelChange(walletAddress, previousLevel, newLevel.name);
    }
  }
}
```

### 4.4 Alert System

```typescript
// src/wallet-tracker/monitoring/alert-system.ts

interface AlertConfig {
  channels: {
    database: boolean;
    websocket: boolean;
    webhook?: string;
    email?: string[];
  };
  thresholds: {
    min_wallets_for_alert: number;
    min_investment_for_alert: number;
    min_score_for_alert: number;
  };
}

class SmartMoneyAlertSystem {
  private config: AlertConfig;
  private alertQueue: Bull.Queue;
  private recentAlerts: Map<string, Date>;
  
  constructor(config: AlertConfig) {
    this.config = config;
    this.alertQueue = new Bull('smart-money-alerts');
    this.recentAlerts = new Map();
    this.setupAlertProcessing();
  }
  
  async createAlert(alert: SmartMoneyAlert) {
    // Deduplicate alerts
    if (this.isDuplicateAlert(alert)) {
      return;
    }
    
    // Determine alert priority
    const priority = this.calculatePriority(alert);
    
    // Queue alert for processing
    await this.alertQueue.add('process-alert', {
      alert,
      priority
    }, {
      priority,
      removeOnComplete: true
    });
    
    // Track recent alerts
    this.recentAlerts.set(alert.token_mint, new Date());
  }
  
  private calculatePriority(alert: SmartMoneyAlert): number {
    let priority = 0;
    
    // Higher wallet scores = higher priority
    const avgScore = alert.smart_wallets.reduce((sum, w) => 
      sum + w.trader_score, 0
    ) / alert.smart_wallets.length;
    
    priority += Math.floor(avgScore / 100);
    
    // More wallets = higher priority
    priority += alert.smart_wallets.length * 2;
    
    // Larger investments = higher priority
    const totalInvestment = alert.smart_wallets.reduce((sum, w) =>
      sum + w.investment_size, 0
    );
    priority += Math.floor(totalInvestment / 10);
    
    // Critical urgency = max priority
    if (alert.urgency_level === 'critical') {
      priority = 100;
    }
    
    return Math.min(100, priority);
  }
  
  private setupAlertProcessing() {
    this.alertQueue.process('process-alert', async (job) => {
      const { alert, priority } = job.data;
      
      try {
        // Store in database
        if (this.config.channels.database) {
          await this.storeAlert(alert);
        }
        
        // Send to websocket subscribers
        if (this.config.channels.websocket) {
          this.broadcastAlert(alert);
        }
        
        // Send webhook
        if (this.config.channels.webhook) {
          await this.sendWebhook(alert);
        }
        
        // Send email for critical alerts
        if (this.config.channels.email && priority >= 90) {
          await this.sendEmailAlert(alert);
        }
        
        // Log alert
        console.log(`[ALERT] Smart money signal for ${alert.token_mint}`);
        console.log(`  Priority: ${priority}`);
        console.log(`  Wallets: ${alert.smart_wallets.length}`);
        console.log(`  Investment: ${alert.total_investment_sol} SOL`);
        
      } catch (error) {
        console.error('Failed to process alert:', error);
        throw error;
      }
    });
  }
  
  private async storeAlert(alert: SmartMoneyAlert) {
    await this.db.query(`
      INSERT INTO smart_money_alerts (
        token_mint,
        alert_type,
        urgency_level,
        smart_wallets_count,
        total_investment_sol,
        avg_trader_score,
        signal_strength,
        smart_wallets_data,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      alert.token_mint,
      alert.type,
      alert.urgency_level,
      alert.smart_wallets.length,
      alert.total_investment_sol,
      alert.avg_trader_score,
      alert.signal_strength,
      JSON.stringify(alert.smart_wallets),
      new Date()
    ]);
  }
  
  private broadcastAlert(alert: SmartMoneyAlert) {
    // Broadcast to all connected websocket clients
    this.io.emit('smart-money-alert', {
      token: alert.token_mint,
      urgency: alert.urgency_level,
      wallets: alert.smart_wallets.length,
      investment: alert.total_investment_sol,
      strength: alert.signal_strength,
      timestamp: new Date()
    });
  }
  
  async getRecentAlerts(limit: number = 50): Promise<SmartMoneyAlert[]> {
    return await this.db.query(`
      SELECT * FROM smart_money_alerts
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
  }
  
  async getAlertStats(hours: number = 24): Promise<AlertStats> {
    const stats = await this.db.query(`
      SELECT 
        COUNT(*) as total_alerts,
        COUNT(DISTINCT token_mint) as unique_tokens,
        AVG(smart_wallets_count) as avg_wallets,
        SUM(total_investment_sol) as total_investment,
        MAX(signal_strength) as max_strength
      FROM smart_money_alerts
      WHERE created_at > NOW() - INTERVAL '%s hours'
    `, [hours]);
    
    return stats[0];
  }
}
```

### 4.5 Real-time Dashboard

```typescript
// src/wallet-tracker/monitoring/dashboard-server.ts

class RealtimeDashboard {
  private io: SocketIO.Server;
  private monitor: SmartMoneyMonitor;
  private updateInterval: number = 1000; // 1 second
  
  constructor(server: http.Server) {
    this.io = new SocketIO.Server(server, {
      cors: {
        origin: process.env.DASHBOARD_URL || 'http://localhost:3000',
        methods: ['GET', 'POST']
      }
    });
    
    this.setupSocketHandlers();
    this.startDataStreaming();
  }
  
  private setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`Client connected: ${socket.id}`);
      
      // Send initial data
      this.sendInitialData(socket);
      
      // Handle subscriptions
      socket.on('subscribe', async (data) => {
        if (data.type === 'wallet') {
          socket.join(`wallet:${data.address}`);
          await this.sendWalletData(socket, data.address);
        } else if (data.type === 'token') {
          socket.join(`token:${data.mint}`);
          await this.sendTokenData(socket, data.mint);
        } else if (data.type === 'alerts') {
          socket.join('alerts');
        }
      });
      
      // Handle unsubscribe
      socket.on('unsubscribe', (data) => {
        if (data.type === 'wallet') {
          socket.leave(`wallet:${data.address}`);
        } else if (data.type === 'token') {
          socket.leave(`token:${data.mint}`);
        }
      });
      
      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
      });
    });
  }
  
  private async sendInitialData(socket: SocketIO.Socket) {
    // Send top wallets
    const topWallets = await this.getTopWallets(20);
    socket.emit('top-wallets', topWallets);
    
    // Send recent signals
    const recentSignals = await this.getRecentSignals(10);
    socket.emit('recent-signals', recentSignals);
    
    // Send system stats
    const stats = await this.getSystemStats();
    socket.emit('system-stats', stats);
  }
  
  private startDataStreaming() {
    setInterval(async () => {
      // Broadcast live metrics
      const liveMetrics = await this.getLiveMetrics();
      this.io.emit('live-metrics', liveMetrics);
      
      // Broadcast active signals
      const activeSignals = Array.from(this.monitor.activeSignals.values());
      this.io.emit('active-signals', activeSignals);
      
    }, this.updateInterval);
    
    // Listen for smart money events
    this.monitor.on('smart-money-buy', (data) => {
      this.io.to(`token:${data.token_mint}`).emit('smart-buy', data);
      this.io.to(`wallet:${data.wallet_address}`).emit('wallet-trade', data);
    });
    
    this.monitor.on('signal-generated', (signal) => {
      this.io.to('alerts').emit('new-signal', signal);
      this.io.to(`token:${signal.token_mint}`).emit('token-signal', signal);
    });
  }
  
  private async getLiveMetrics(): Promise<LiveMetrics> {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    const metrics = await this.db.query(`
      SELECT 
        COUNT(DISTINCT wallet_address) as active_wallets,
        COUNT(*) as total_transactions,
        SUM(sol_amount) as total_volume,
        COUNT(DISTINCT token_mint) as unique_tokens
      FROM wallet_trades
      WHERE block_time > $1
    `, [oneHourAgo]);
    
    const signals = await this.db.query(`
      SELECT COUNT(*) as signal_count
      FROM token_smart_money_signals
      WHERE created_at > $1
    `, [oneHourAgo]);
    
    return {
      active_wallets: metrics[0].active_wallets,
      transactions_1h: metrics[0].total_transactions,
      volume_1h: metrics[0].total_volume,
      unique_tokens_1h: metrics[0].unique_tokens,
      signals_1h: signals[0].signal_count,
      timestamp: now
    };
  }
  
  async getTopWallets(limit: number): Promise<WalletSummary[]> {
    return await this.db.query(`
      SELECT 
        w.wallet_address,
        w.trader_score,
        w.total_pnl_sol,
        w.win_rate,
        w.last_activity_at,
        COUNT(DISTINCT t.token_mint) as active_positions
      FROM wallet_traders w
      LEFT JOIN wallet_trades t ON t.wallet_address = w.wallet_address
        AND t.block_time > NOW() - INTERVAL '24 hours'
      WHERE w.trader_score >= 700
      GROUP BY w.wallet_address, w.trader_score, w.total_pnl_sol, 
               w.win_rate, w.last_activity_at
      ORDER BY w.trader_score DESC
      LIMIT $1
    `, [limit]);
  }
}
```

### 4.6 Performance Tracking

```typescript
// src/wallet-tracker/monitoring/performance-tracker.ts

class SignalPerformanceTracker {
  private performanceCache: Map<string, SignalPerformance>;
  
  async trackSignal(signal: SmartMoneySignal) {
    const signalId = uuidv4();
    
    // Store initial signal
    await this.db.query(`
      INSERT INTO signal_tracking (
        signal_id,
        token_mint,
        signal_timestamp,
        initial_price,
        smart_wallets_count,
        total_investment_sol,
        avg_trader_score,
        signal_strength
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      signalId,
      signal.token_mint,
      signal.generated_at,
      signal.smart_wallets[0].entry_price,
      signal.smart_wallets.length,
      signal.total_investment_sol,
      signal.avg_trader_score,
      signal.signal_strength
    ]);
    
    // Schedule performance checks
    this.schedulePerformanceChecks(signalId, signal);
    
    return signalId;
  }
  
  private schedulePerformanceChecks(signalId: string, signal: SmartMoneySignal) {
    const checkpoints = [
      { time: 5 * 60 * 1000, label: '5min' },
      { time: 30 * 60 * 1000, label: '30min' },
      { time: 2 * 60 * 60 * 1000, label: '2hr' },
      { time: 24 * 60 * 60 * 1000, label: '24hr' },
      { time: 7 * 24 * 60 * 60 * 1000, label: '7d' }
    ];
    
    for (const checkpoint of checkpoints) {
      setTimeout(async () => {
        await this.checkSignalPerformance(signalId, signal, checkpoint.label);
      }, checkpoint.time);
    }
  }
  
  private async checkSignalPerformance(
    signalId: string,
    signal: SmartMoneySignal,
    checkpoint: string
  ) {
    // Get current token metrics
    const currentPrice = await this.getCurrentPrice(signal.token_mint);
    const initialPrice = signal.smart_wallets[0].entry_price;
    
    const priceChange = ((currentPrice - initialPrice) / initialPrice) * 100;
    
    // Check if graduated
    const graduated = await this.checkIfGraduated(signal.token_mint);
    
    // Store performance
    await this.db.query(`
      INSERT INTO signal_performance (
        signal_id,
        checkpoint,
        price_change_percent,
        current_price,
        graduated,
        measured_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      signalId,
      checkpoint,
      priceChange,
      currentPrice,
      graduated,
      new Date()
    ]);
    
    // Update cache
    if (!this.performanceCache.has(signalId)) {
      this.performanceCache.set(signalId, {
        signal_id: signalId,
        checkpoints: {}
      });
    }
    
    this.performanceCache.get(signalId)!.checkpoints[checkpoint] = {
      price_change: priceChange,
      graduated,
      success: priceChange > 20 || graduated
    };
    
    // Calculate signal accuracy if enough data
    if (checkpoint === '24hr') {
      await this.updateSignalAccuracy();
    }
  }
  
  async updateSignalAccuracy() {
    const results = await this.db.query(`
      SELECT 
        COUNT(*) as total_signals,
        COUNT(CASE WHEN price_change_percent > 20 THEN 1 END) as successful,
        COUNT(CASE WHEN graduated = true THEN 1 END) as graduated,
        AVG(price_change_percent) as avg_return
      FROM signal_performance
      WHERE checkpoint = '24hr'
        AND measured_at > NOW() - INTERVAL '30 days'
    `);
    
    const accuracy = results[0].successful / results[0].total_signals;
    const graduationRate = results[0].graduated / results[0].total_signals;
    
    console.log('Signal Performance (30 days):');
    console.log(`  Accuracy: ${(accuracy * 100).toFixed(2)}%`);
    console.log(`  Graduation Rate: ${(graduationRate * 100).toFixed(2)}%`);
    console.log(`  Avg Return: ${results[0].avg_return.toFixed(2)}%`);
    
    // Store aggregate stats
    await this.storeAggregateStats({
      accuracy,
      graduation_rate: graduationRate,
      avg_return: results[0].avg_return,
      total_signals: results[0].total_signals
    });
  }
}
```

## Implementation Steps

### Step 1: Setup Real-time Infrastructure
```bash
# Install dependencies
npm install socket.io bull ioredis @grpc/grpc-js

# Setup Redis for queues and caching
docker run -d -p 6379:6379 redis:alpine

# Configure environment
echo "REDIS_URL=redis://localhost:6379" >> .env
echo "DASHBOARD_URL=http://localhost:3000" >> .env
```

### Step 2: Initialize Monitoring System
```typescript
// src/wallet-tracker/scripts/start-monitoring.ts

async function startMonitoring() {
  console.log('Starting smart money monitoring system...');
  
  // Initialize components
  const monitor = new SmartMoneyMonitor({
    smartMoneyThreshold: 700,
    signalThreshold: 3,
    updateInterval: 1000,
    batchSize: 100
  });
  
  const signalGenerator = new SmartMoneySignalGenerator();
  const alertSystem = new SmartMoneyAlertSystem({
    channels: {
      database: true,
      websocket: true,
      webhook: process.env.WEBHOOK_URL
    },
    thresholds: {
      min_wallets_for_alert: 3,
      min_investment_for_alert: 10,
      min_score_for_alert: 700
    }
  });
  
  const performanceTracker = new SignalPerformanceTracker();
  
  // Start monitoring
  await monitor.start();
  console.log('Monitor started');
  
  // Setup event handlers
  monitor.on('smart-money-buy', async (data) => {
    console.log(`Smart money buy detected: ${data.wallet_address} -> ${data.token_mint}`);
  });
  
  monitor.on('signal-generated', async (signal) => {
    console.log(`Signal generated for ${signal.token_mint}`);
    
    // Track performance
    const signalId = await performanceTracker.trackSignal(signal);
    console.log(`Tracking signal: ${signalId}`);
    
    // Create alert
    await alertSystem.createAlert({
      ...signal,
      type: 'smart_money_signal'
    });
  });
  
  console.log('Smart money monitoring system running');
}

startMonitoring().catch(console.error);
```

### Step 3: Launch Dashboard
```typescript
// src/wallet-tracker/scripts/start-dashboard.ts

import express from 'express';
import http from 'http';

async function startDashboard() {
  const app = express();
  const server = http.createServer(app);
  
  // Initialize dashboard
  const dashboard = new RealtimeDashboard(server);
  
  // Serve static files
  app.use(express.static('public'));
  
  // API endpoints
  app.get('/api/signals/recent', async (req, res) => {
    const signals = await getRecentSignals(50);
    res.json(signals);
  });
  
  app.get('/api/wallets/top', async (req, res) => {
    const wallets = await getTopWallets(100);
    res.json(wallets);
  });
  
  app.get('/api/performance/stats', async (req, res) => {
    const stats = await getPerformanceStats();
    res.json(stats);
  });
  
  const PORT = process.env.DASHBOARD_PORT || 3001;
  server.listen(PORT, () => {
    console.log(`Dashboard running on http://localhost:${PORT}`);
  });
}

startDashboard().catch(console.error);
```

### Step 4: Configure Alerts
```typescript
// src/wallet-tracker/config/alert-config.ts

export const alertConfig = {
  // Alert thresholds
  thresholds: {
    smart_money: {
      min_wallets: 3,
      min_score: 700,
      min_investment: 10 // SOL
    },
    critical: {
      min_wallets: 5,
      min_score: 900,
      min_investment: 50 // SOL
    }
  },
  
  // Notification channels
  channels: {
    database: true,
    websocket: true,
    webhook: process.env.WEBHOOK_URL,
    email: process.env.ALERT_EMAILS?.split(',')
  },
  
  // Rate limiting
  rateLimits: {
    per_token: 1, // Max 1 alert per token per hour
    per_wallet: 10, // Max 10 alerts per wallet per hour
    global: 100 // Max 100 alerts per hour total
  }
};
```

## Monitoring & Maintenance

### Health Checks
```typescript
class MonitoringHealth {
  async checkHealth(): Promise<HealthStatus> {
    const checks = {
      grpc_connection: await this.checkGrpcConnection(),
      redis_connection: await this.checkRedisConnection(),
      database_connection: await this.checkDatabaseConnection(),
      tracked_wallets: await this.getTrackedWalletsCount(),
      active_signals: await this.getActiveSignalsCount(),
      queue_health: await this.checkQueueHealth()
    };
    
    return {
      healthy: Object.values(checks).every(c => c.healthy),
      checks,
      timestamp: new Date()
    };
  }
}
```

### Performance Metrics
```typescript
class MonitoringMetrics {
  async getMetrics(): Promise<Metrics> {
    return {
      transactions_processed: await this.getTransactionCount(),
      signals_generated: await this.getSignalCount(),
      alerts_sent: await this.getAlertCount(),
      average_latency: await this.getAverageLatency(),
      error_rate: await this.getErrorRate(),
      uptime: await this.getUptime()
    };
  }
}
```

## Success Metrics

### Target Metrics
- Monitor 1000+ smart money wallets
- Process 10,000+ transactions/minute
- Generate signals within 1 second
- Alert delivery within 2 seconds
- Dashboard update rate: 1 second
- Signal accuracy: >70%

### Quality Metrics
- False positive rate: <10%
- Signal-to-graduation rate: >50%
- Alert delivery rate: 99.9%
- System uptime: 99.9%

## Deliverables

1. **Real-time Monitor**: gRPC-based transaction monitoring
2. **Signal Generator**: Smart money signal creation
3. **Alert System**: Multi-channel alert delivery
4. **Performance Tracker**: Signal outcome tracking
5. **Live Dashboard**: WebSocket-based real-time UI
6. **Health Monitoring**: System health and metrics

## Next Phase Prerequisites

Before moving to Phase 5 (Integration & Testing), ensure:
- [ ] Real-time monitoring operational
- [ ] Signal generation working
- [ ] Alert system tested
- [ ] Dashboard functional
- [ ] Performance tracking active
- [ ] Health checks passing