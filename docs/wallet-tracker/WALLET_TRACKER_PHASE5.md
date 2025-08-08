# Phase 5: Integration & Testing (Week 5-6)

## Overview
The final phase focuses on integrating the wallet tracking system with the existing Megatron infrastructure, comprehensive testing of all components, performance optimization, and deployment preparation. This phase ensures the system works seamlessly with existing monitors and contributes effectively to token scoring.

## Objectives
1. Integrate wallet scores into the 999-point token scoring system
2. Connect with existing Pump.fun and Raydium monitors
3. Implement comprehensive testing suite
4. Optimize performance and scalability
5. Create deployment and operational procedures
6. Validate system accuracy and effectiveness

## Technical Architecture

### 5.1 Megatron Integration

```typescript
// src/wallet-tracker/integration/megatron-integration.ts

interface MegatronIntegration {
  integrateWithTokenScoring(): Promise<void>;
  connectToMonitors(): Promise<void>;
  syncWithDatabase(): Promise<void>;
  validateIntegration(): Promise<boolean>;
}

class WalletTrackerIntegration implements MegatronIntegration {
  private technicalScorer: TechnicalScorer;
  private holderScorer: HolderScorer;
  private walletScorer: TokenWalletScorer;
  
  async integrateWithTokenScoring(): Promise<void> {
    console.log('Integrating wallet tracker with Megatron token scoring...');
    
    // Extend the existing token scoring system
    await this.extendTokenScoringSystem();
    
    // Update scoring calculation to include wallet score
    await this.updateScoringCalculation();
    
    // Verify integration
    const testToken = await this.getTestToken();
    const score = await this.calculateCompleteScore(testToken);
    
    console.log(`Test token ${testToken} complete score:`, {
      technical: score.technical,
      holder: score.holder,
      wallet: score.wallet,
      total: score.total
    });
  }
  
  private async extendTokenScoringSystem() {
    // Add wallet score to the token scoring interface
    const migration = `
      ALTER TABLE technical_scores
      ADD COLUMN IF NOT EXISTS wallet_score DECIMAL(10, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS wallet_score_components JSONB DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS smart_wallets_count INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS smart_money_invested DECIMAL(20, 9) DEFAULT 0;
      
      -- Create index for wallet scores
      CREATE INDEX IF NOT EXISTS idx_technical_scores_wallet 
      ON technical_scores(wallet_score DESC);
    `;
    
    await this.db.query(migration);
  }
  
  async calculateCompleteScore(tokenMint: string): Promise<TokenScore> {
    // Get all three score components
    const [technical, holder, wallet] = await Promise.all([
      this.technicalScorer.calculateScore(tokenMint),
      this.holderScorer.calculateScore(tokenMint),
      this.walletScorer.calculateTokenWalletScore(tokenMint)
    ]);
    
    // Combine into final 999-point score
    const total = technical + holder + wallet.wallet_score;
    
    // Store complete score
    await this.storeCompleteScore({
      token_mint: tokenMint,
      technical_score: technical,
      holder_score: holder,
      wallet_score: wallet.wallet_score,
      total_score: total,
      wallet_components: wallet.components,
      smart_wallets: wallet.smart_wallets,
      calculated_at: new Date()
    });
    
    return {
      technical,
      holder,
      wallet: wallet.wallet_score,
      total,
      percentile: await this.calculatePercentile(total)
    };
  }
  
  async connectToMonitors(): Promise<void> {
    // Connect to Pump.fun monitors
    await this.connectToPumpfunMonitors();
    
    // Connect to Raydium monitors
    await this.connectToRaydiumMonitors();
    
    // Connect to graduation monitor
    await this.connectToGraduationMonitor();
  }
  
  private async connectToPumpfunMonitors() {
    // Listen to transaction monitor
    eventEmitter.on('pumpfun:transaction', async (tx) => {
      if (tx.type === 'buy' && this.isTrackedWallet(tx.signer)) {
        await this.handleSmartMoneyTransaction(tx);
      }
    });
    
    // Listen to price monitor for exit tracking
    eventEmitter.on('pumpfun:price-update', async (update) => {
      await this.updateUnrealizedPnL(update);
    });
    
    console.log('Connected to Pump.fun monitors');
  }
  
  private async connectToRaydiumMonitors() {
    // Listen to Raydium transactions
    eventEmitter.on('raydium:transaction', async (tx) => {
      if (this.isTrackedWallet(tx.signer)) {
        await this.handleSmartMoneyTransaction(tx);
      }
    });
    
    console.log('Connected to Raydium monitors');
  }
  
  private async connectToGraduationMonitor() {
    // Listen for graduations to update wallet scores
    eventEmitter.on('token:graduated', async (graduation) => {
      await this.handleGraduation(graduation);
    });
    
    console.log('Connected to graduation monitor');
  }
  
  private async handleGraduation(graduation: GraduationEvent) {
    // Find all wallets that traded this token
    const traders = await this.db.query(`
      SELECT DISTINCT wallet_address
      FROM wallet_trades
      WHERE token_mint = $1
    `, [graduation.token_mint]);
    
    // Update their graduation metrics
    for (const trader of traders) {
      await this.updateGraduationMetrics(
        trader.wallet_address,
        graduation.token_mint
      );
    }
    
    // Recalculate scores for top traders
    const topTraders = traders.filter(t => 
      this.isHighScoreWallet(t.wallet_address)
    );
    
    for (const trader of topTraders) {
      await this.queueScoreRecalculation(trader.wallet_address);
    }
  }
}
```

### 5.2 Comprehensive Testing Suite

```typescript
// src/wallet-tracker/tests/integration-tests.ts

describe('Wallet Tracker Integration Tests', () => {
  let integration: WalletTrackerIntegration;
  let monitor: SmartMoneyMonitor;
  let scorer: WalletScorer;
  
  beforeAll(async () => {
    // Setup test environment
    await setupTestDatabase();
    await seedTestData();
    
    integration = new WalletTrackerIntegration();
    monitor = new SmartMoneyMonitor(testConfig);
    scorer = new WalletScorer();
  });
  
  describe('Historical Data Collection', () => {
    test('should correctly identify early buyers', async () => {
      const token = 'test_graduated_token';
      const earlyBuyers = await identifyEarlyBuyers(token);
      
      expect(earlyBuyers.length).toBeGreaterThan(0);
      expect(earlyBuyers[0]).toHaveProperty('minutes_before_graduation');
      expect(earlyBuyers[0].minutes_before_graduation).toBeGreaterThan(0);
    });
    
    test('should filter out dev wallets and bots', async () => {
      const buyers = await getTokenBuyers('test_token_with_bots');
      const filtered = await filterSuspiciousWallets(buyers);
      
      expect(filtered.length).toBeLessThan(buyers.length);
      expect(filtered.every(b => !b.is_dev_wallet)).toBe(true);
      expect(filtered.every(b => !b.is_sniper_bot)).toBe(true);
    });
  });
  
  describe('PnL Calculation', () => {
    test('should calculate realized PnL correctly', async () => {
      const position = await createTestPosition({
        entries: [
          { amount: 1000, price: 0.001, timestamp: Date.now() - 3600000 }
        ],
        exits: [
          { amount: 1000, price: 0.003, timestamp: Date.now() }
        ]
      });
      
      const pnl = await calculateRealizedPnL(position);
      
      expect(pnl.sol_profit).toBeCloseTo(2, 6); // 0.003 - 0.001 = 0.002 SOL per token
      expect(pnl.roi_percentage).toBeCloseTo(200, 2);
      expect(pnl.multiple).toBeCloseTo(3, 2);
    });
    
    test('should handle partial sells correctly', async () => {
      const position = await createTestPosition({
        entries: [
          { amount: 1000, price: 0.001, timestamp: Date.now() - 3600000 }
        ],
        exits: [
          { amount: 500, price: 0.002, timestamp: Date.now() - 1800000 },
          { amount: 500, price: 0.003, timestamp: Date.now() }
        ]
      });
      
      const pnl = await calculateRealizedPnL(position);
      
      expect(pnl.sol_profit).toBeCloseTo(1.5, 6);
      expect(position.current_balance).toBe(0);
    });
    
    test('should calculate unrealized PnL correctly', async () => {
      const position = await createTestPosition({
        entries: [
          { amount: 1000, price: 0.001, timestamp: Date.now() - 3600000 }
        ],
        exits: [],
        current_balance: 1000
      });
      
      const currentPrice = 0.005;
      const unrealizedPnL = await calculateUnrealizedPnL(position, currentPrice);
      
      expect(unrealizedPnL.sol_profit).toBeCloseTo(4, 6);
      expect(unrealizedPnL.roi_percentage).toBeCloseTo(400, 2);
    });
  });
  
  describe('Wallet Scoring', () => {
    test('should heavily weight profitability', async () => {
      const profitableWallet = await createTestWallet({
        total_pnl_sol: 1000,
        total_pnl_usd: 50000,
        win_rate: 60,
        graduated_tokens_traded: 10
      });
      
      const unprofitableWallet = await createTestWallet({
        total_pnl_sol: -100,
        total_pnl_usd: -5000,
        win_rate: 90,
        graduated_tokens_traded: 50
      });
      
      const profitableScore = await scorer.calculateWalletScore(profitableWallet.address);
      const unprofitableScore = await scorer.calculateWalletScore(unprofitableWallet.address);
      
      expect(profitableScore.total_score).toBeGreaterThan(unprofitableScore.total_score);
      expect(profitableScore.components.profitability.total).toBeGreaterThan(400);
    });
    
    test('should apply minimal decay for profitable wallets', async () => {
      const wallet = await createTestWallet({
        total_pnl_sol: 500,
        last_activity_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
      });
      
      const score = await scorer.calculateWalletScore(wallet.address);
      
      expect(score.decay_factor).toBeGreaterThanOrEqual(0.8);
      expect(score.decay_factor).toBeLessThanOrEqual(1.0);
    });
  });
  
  describe('Token Wallet Scoring', () => {
    test('should calculate 0-333 points correctly', async () => {
      const token = await createTestToken();
      
      // Add smart money buyers
      await addSmartMoneyBuyers(token, [
        { wallet: 'wallet1', score: 800, investment: 50 },
        { wallet: 'wallet2', score: 750, investment: 30 },
        { wallet: 'wallet3', score: 900, investment: 40 }
      ]);
      
      const tokenScore = await calculateTokenWalletScore(token);
      
      expect(tokenScore.wallet_score).toBeGreaterThan(0);
      expect(tokenScore.wallet_score).toBeLessThanOrEqual(333);
      expect(tokenScore.components.smart_wallet_count).toBeLessThanOrEqual(100);
      expect(tokenScore.components.avg_trader_quality).toBeLessThanOrEqual(133);
      expect(tokenScore.components.total_investment).toBeLessThanOrEqual(100);
    });
    
    test('should weight by profitability and investment', async () => {
      const token1 = await createTestToken();
      const token2 = await createTestToken();
      
      // Token 1: Few high-profit wallets with large investments
      await addSmartMoneyBuyers(token1, [
        { wallet: 'whale1', score: 950, investment: 200, profit: 5000 },
        { wallet: 'whale2', score: 920, investment: 150, profit: 3000 }
      ]);
      
      // Token 2: Many low-profit wallets with small investments
      await addSmartMoneyBuyers(token2, [
        { wallet: 'small1', score: 710, investment: 5, profit: 50 },
        { wallet: 'small2', score: 720, investment: 5, profit: 60 },
        { wallet: 'small3', score: 705, investment: 5, profit: 40 },
        { wallet: 'small4', score: 715, investment: 5, profit: 55 }
      ]);
      
      const score1 = await calculateTokenWalletScore(token1);
      const score2 = await calculateTokenWalletScore(token2);
      
      expect(score1.wallet_score).toBeGreaterThan(score2.wallet_score);
    });
  });
  
  describe('Real-time Monitoring', () => {
    test('should detect smart money buys', async () => {
      const smartWallet = await createSmartMoneyWallet({ score: 850 });
      
      const buyDetected = new Promise((resolve) => {
        monitor.on('smart-money-buy', resolve);
      });
      
      // Simulate buy transaction
      await simulateTransaction({
        signer: smartWallet.address,
        type: 'buy',
        token: 'test_token',
        amount: 100
      });
      
      const detected = await buyDetected;
      expect(detected).toHaveProperty('wallet_address', smartWallet.address);
    });
    
    test('should generate signals when threshold met', async () => {
      const token = 'signal_test_token';
      const signalGenerated = new Promise((resolve) => {
        monitor.on('signal-generated', (signal) => {
          if (signal.token_mint === token) resolve(signal);
        });
      });
      
      // Simulate multiple smart money buys
      for (let i = 0; i < 3; i++) {
        const wallet = await createSmartMoneyWallet({ score: 800 + i * 50 });
        await simulateTransaction({
          signer: wallet.address,
          type: 'buy',
          token,
          amount: 50
        });
      }
      
      const signal = await signalGenerated;
      expect(signal.smart_wallets.length).toBeGreaterThanOrEqual(3);
      expect(signal.signal_strength).toBeGreaterThan(0);
    });
  });
  
  describe('Performance', () => {
    test('should process 1000 wallets in under 60 seconds', async () => {
      const wallets = await createTestWallets(1000);
      
      const startTime = Date.now();
      await Promise.all(
        wallets.map(w => scorer.calculateWalletScore(w.address))
      );
      const endTime = Date.now();
      
      const duration = (endTime - startTime) / 1000;
      expect(duration).toBeLessThan(60);
    });
    
    test('should handle 10000 transactions per minute', async () => {
      const transactions = generateTestTransactions(10000);
      
      const startTime = Date.now();
      for (const tx of transactions) {
        await monitor.processTransaction(tx);
      }
      const endTime = Date.now();
      
      const duration = (endTime - startTime) / 1000;
      expect(duration).toBeLessThan(60);
    });
  });
});
```

### 5.3 Performance Optimization

```typescript
// src/wallet-tracker/optimization/performance-optimizer.ts

class PerformanceOptimizer {
  async optimizeDatabase() {
    console.log('Optimizing database performance...');
    
    // Create additional indexes
    await this.createOptimizedIndexes();
    
    // Partition large tables
    await this.partitionTables();
    
    // Create materialized views
    await this.createMaterializedViews();
    
    // Optimize query plans
    await this.analyzeAndVacuum();
  }
  
  private async createOptimizedIndexes() {
    const indexes = [
      // Composite indexes for common queries
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_trades_composite 
       ON wallet_trades(wallet_address, token_mint, block_time DESC)`,
      
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_positions_composite 
       ON wallet_positions(wallet_address, status, updated_at DESC)`,
      
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scores_composite 
       ON wallet_traders(trader_score DESC, last_activity_at DESC)`,
      
      // Partial indexes for filtered queries
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_smart_money 
       ON wallet_traders(wallet_address) 
       WHERE trader_score >= 700`,
      
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_graduated_positions 
       ON wallet_positions(token_mint) 
       WHERE is_graduated = true`
    ];
    
    for (const index of indexes) {
      await this.db.query(index);
    }
  }
  
  private async partitionTables() {
    // Partition wallet_trades by time
    const partitionQuery = `
      -- Create partitioned table
      CREATE TABLE IF NOT EXISTS wallet_trades_partitioned (
        LIKE wallet_trades INCLUDING ALL
      ) PARTITION BY RANGE (block_time);
      
      -- Create monthly partitions
      CREATE TABLE IF NOT EXISTS wallet_trades_2024_01 
        PARTITION OF wallet_trades_partitioned
        FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
      
      CREATE TABLE IF NOT EXISTS wallet_trades_2024_02 
        PARTITION OF wallet_trades_partitioned
        FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
      
      -- Add more partitions as needed
    `;
    
    await this.db.query(partitionQuery);
  }
  
  private async createMaterializedViews() {
    const views = [
      {
        name: 'wallet_summary_mv',
        query: `
          CREATE MATERIALIZED VIEW IF NOT EXISTS wallet_summary_mv AS
          SELECT 
            w.wallet_address,
            w.trader_score,
            w.total_pnl_sol,
            w.win_rate,
            COUNT(DISTINCT p.token_mint) as tokens_traded,
            COUNT(CASE WHEN p.is_graduated THEN 1 END) as graduated_tokens,
            MAX(t.block_time) as last_trade_time
          FROM wallet_traders w
          LEFT JOIN wallet_positions p ON p.wallet_address = w.wallet_address
          LEFT JOIN wallet_trades t ON t.wallet_address = w.wallet_address
          GROUP BY w.wallet_address, w.trader_score, w.total_pnl_sol, w.win_rate
        `
      },
      {
        name: 'token_smart_money_mv',
        query: `
          CREATE MATERIALIZED VIEW IF NOT EXISTS token_smart_money_mv AS
          SELECT 
            t.token_mint,
            COUNT(DISTINCT w.wallet_address) as smart_wallet_count,
            AVG(w.trader_score) as avg_trader_score,
            SUM(t.sol_amount) as total_smart_investment
          FROM wallet_trades t
          JOIN wallet_traders w ON w.wallet_address = t.wallet_address
          WHERE w.trader_score >= 700
            AND t.trade_type = 'buy'
          GROUP BY t.token_mint
        `
      }
    ];
    
    for (const view of views) {
      await this.db.query(view.query);
      await this.db.query(`CREATE UNIQUE INDEX ON ${view.name}(wallet_address)`);
    }
  }
  
  async optimizeCaching() {
    // Configure Redis caching
    const redis = new Redis({
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true
    });
    
    // Implement multi-tier caching
    const cacheConfig = {
      L1: { // In-memory cache
        maxSize: 1000,
        ttl: 60 // 1 minute
      },
      L2: { // Redis cache
        ttl: 300 // 5 minutes
      },
      L3: { // Database
        // Fallback when cache misses
      }
    };
    
    return new CacheManager(cacheConfig);
  }
  
  async implementBatching() {
    // Batch database operations
    const batcher = new BatchProcessor({
      batchSize: 100,
      flushInterval: 1000, // 1 second
      maxRetries: 3
    });
    
    // Batch score calculations
    batcher.on('batch-ready', async (batch) => {
      await this.processBatch(batch);
    });
    
    return batcher;
  }
}
```

### 5.4 Deployment Configuration

```yaml
# docker-compose.yml
version: '3.8'

services:
  wallet-tracker:
    build: .
    environment:
      - NODE_ENV=production
      - DB_HOST=postgres
      - REDIS_HOST=redis
      - GRPC_URL=${GRPC_URL}
      - X_TOKEN=${X_TOKEN}
    depends_on:
      - postgres
      - redis
    ports:
      - "3001:3001"
    restart: unless-stopped
    
  postgres:
    image: timescale/timescaledb:2.11.0-pg15
    environment:
      - POSTGRES_DB=megatron_v2
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    
  monitor:
    build: 
      context: .
      dockerfile: Dockerfile.monitor
    environment:
      - NODE_ENV=production
    depends_on:
      - wallet-tracker
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Run migrations
RUN npm run migrate

# Start application
CMD ["npm", "run", "start:prod"]
```

### 5.5 Monitoring & Observability

```typescript
// src/wallet-tracker/monitoring/observability.ts

import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

class ObservabilitySetup {
  private meterProvider: MeterProvider;
  private meters: Map<string, Meter>;
  
  async setupMetrics() {
    // Prometheus metrics
    const exporter = new PrometheusExporter({
      port: 9464,
    });
    
    this.meterProvider = new MeterProvider({
      exporter,
      interval: 1000,
    });
    
    // Define metrics
    const meter = this.meterProvider.getMeter('wallet-tracker');
    
    // Counter metrics
    const transactionCounter = meter.createCounter('transactions_processed', {
      description: 'Total transactions processed'
    });
    
    const signalCounter = meter.createCounter('signals_generated', {
      description: 'Total smart money signals generated'
    });
    
    // Gauge metrics
    const activeWalletsGauge = meter.createObservableGauge('active_wallets', {
      description: 'Number of active smart money wallets'
    });
    
    const scoreDistribution = meter.createHistogram('wallet_scores', {
      description: 'Distribution of wallet scores',
      boundaries: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    });
    
    // Latency metrics
    const scoringLatency = meter.createHistogram('scoring_latency_ms', {
      description: 'Wallet scoring latency in milliseconds'
    });
    
    return {
      transactionCounter,
      signalCounter,
      activeWalletsGauge,
      scoreDistribution,
      scoringLatency
    };
  }
  
  async setupLogging() {
    // Structured logging with Winston
    const winston = require('winston');
    
    const logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ 
          filename: 'logs/error.log', 
          level: 'error' 
        }),
        new winston.transports.File({ 
          filename: 'logs/combined.log' 
        }),
        new winston.transports.Console({
          format: winston.format.simple()
        })
      ]
    });
    
    return logger;
  }
  
  async setupTracing() {
    // OpenTelemetry tracing
    const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
    const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
    
    const provider = new NodeTracerProvider();
    
    const exporter = new JaegerExporter({
      endpoint: 'http://localhost:14268/api/traces',
    });
    
    provider.addSpanProcessor(
      new BatchSpanProcessor(exporter)
    );
    
    provider.register();
    
    return provider.getTracer('wallet-tracker');
  }
}
```

### 5.6 Validation & Quality Assurance

```typescript
// src/wallet-tracker/validation/system-validator.ts

class SystemValidator {
  async validateComplete(): Promise<ValidationReport> {
    console.log('Running complete system validation...');
    
    const validations = {
      dataIntegrity: await this.validateDataIntegrity(),
      scoringAccuracy: await this.validateScoringAccuracy(),
      pnlCalculations: await this.validatePnLCalculations(),
      signalQuality: await this.validateSignalQuality(),
      performanceMetrics: await this.validatePerformance(),
      integrationPoints: await this.validateIntegrations()
    };
    
    const report: ValidationReport = {
      timestamp: new Date(),
      passed: Object.values(validations).every(v => v.passed),
      validations,
      recommendations: this.generateRecommendations(validations)
    };
    
    await this.saveValidationReport(report);
    
    return report;
  }
  
  private async validateDataIntegrity(): Promise<ValidationResult> {
    const checks = [];
    
    // Check for orphaned records
    const orphanedTrades = await this.db.query(`
      SELECT COUNT(*) as count
      FROM wallet_trades t
      LEFT JOIN wallet_traders w ON w.wallet_address = t.wallet_address
      WHERE w.wallet_address IS NULL
    `);
    
    checks.push({
      name: 'No orphaned trades',
      passed: orphanedTrades[0].count === 0,
      details: `Found ${orphanedTrades[0].count} orphaned trades`
    });
    
    // Check for data consistency
    const inconsistentPnL = await this.db.query(`
      SELECT COUNT(*) as count
      FROM wallet_positions
      WHERE realized_pnl_sol + unrealized_pnl_sol != 
            (SELECT SUM(CASE WHEN trade_type = 'exit' THEN sol_amount ELSE -sol_amount END)
             FROM position_trades
             WHERE position_id = wallet_positions.id)
    `);
    
    checks.push({
      name: 'PnL consistency',
      passed: inconsistentPnL[0].count === 0,
      details: `Found ${inconsistentPnL[0].count} inconsistent PnL calculations`
    });
    
    return {
      passed: checks.every(c => c.passed),
      checks
    };
  }
  
  private async validateScoringAccuracy(): Promise<ValidationResult> {
    // Sample wallets and recalculate scores
    const sampleWallets = await this.db.query(`
      SELECT wallet_address, trader_score
      FROM wallet_traders
      ORDER BY RANDOM()
      LIMIT 100
    `);
    
    const scorer = new WalletScorer();
    let mismatches = 0;
    
    for (const wallet of sampleWallets) {
      const recalculated = await scorer.calculateWalletScore(wallet.wallet_address);
      const difference = Math.abs(recalculated.total_score - wallet.trader_score);
      
      if (difference > 1) { // Allow 1 point tolerance
        mismatches++;
      }
    }
    
    return {
      passed: mismatches < 5, // Less than 5% error rate
      checks: [{
        name: 'Score calculation accuracy',
        passed: mismatches < 5,
        details: `${mismatches}/100 scores had discrepancies`
      }]
    };
  }
  
  private async validateSignalQuality(): Promise<ValidationResult> {
    // Check historical signal performance
    const signalStats = await this.db.query(`
      SELECT 
        COUNT(*) as total_signals,
        COUNT(CASE WHEN graduated = true THEN 1 END) as graduated,
        AVG(price_change_percent) as avg_return
      FROM signal_performance
      WHERE checkpoint = '24hr'
        AND measured_at > NOW() - INTERVAL '7 days'
    `);
    
    const stats = signalStats[0];
    const graduationRate = stats.graduated / stats.total_signals;
    
    return {
      passed: graduationRate > 0.5 && stats.avg_return > 20,
      checks: [{
        name: 'Signal quality metrics',
        passed: graduationRate > 0.5,
        details: `Graduation rate: ${(graduationRate * 100).toFixed(2)}%, Avg return: ${stats.avg_return.toFixed(2)}%`
      }]
    };
  }
  
  private async validatePerformance(): Promise<ValidationResult> {
    const checks = [];
    
    // Test scoring speed
    const startTime = Date.now();
    const testWallet = await this.getRandomWallet();
    await new WalletScorer().calculateWalletScore(testWallet);
    const scoringTime = Date.now() - startTime;
    
    checks.push({
      name: 'Scoring latency',
      passed: scoringTime < 100,
      details: `Scoring took ${scoringTime}ms`
    });
    
    // Test query performance
    const queryStart = Date.now();
    await this.db.query(`
      SELECT * FROM wallet_traders
      WHERE trader_score >= 700
      ORDER BY trader_score DESC
      LIMIT 100
    `);
    const queryTime = Date.now() - queryStart;
    
    checks.push({
      name: 'Query performance',
      passed: queryTime < 50,
      details: `Query took ${queryTime}ms`
    });
    
    return {
      passed: checks.every(c => c.passed),
      checks
    };
  }
}
```

## Implementation Steps

### Step 1: Integration Setup
```bash
# Update database schema
npx ts-node src/database/migrations/004_wallet_integration_tables.sql

# Verify existing monitors
npx ts-node src/wallet-tracker/scripts/verify-monitors.ts

# Test integration points
npx ts-node src/wallet-tracker/scripts/test-integration.ts
```

### Step 2: Run Complete Test Suite
```bash
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# Performance tests
npm run test:performance

# End-to-end tests
npm run test:e2e

# Generate coverage report
npm run test:coverage
```

### Step 3: Performance Optimization
```typescript
// src/wallet-tracker/scripts/optimize-system.ts

async function optimizeSystem() {
  const optimizer = new PerformanceOptimizer();
  
  console.log('Starting system optimization...');
  
  // Database optimization
  await optimizer.optimizeDatabase();
  console.log('✓ Database optimized');
  
  // Caching setup
  const cacheManager = await optimizer.optimizeCaching();
  console.log('✓ Caching configured');
  
  // Batching implementation
  const batcher = await optimizer.implementBatching();
  console.log('✓ Batching enabled');
  
  // Run performance benchmarks
  const benchmarks = await runBenchmarks();
  console.log('Performance benchmarks:', benchmarks);
}

optimizeSystem().catch(console.error);
```

### Step 4: Deployment
```bash
# Build Docker images
docker-compose build

# Run database migrations
docker-compose run wallet-tracker npm run migrate

# Start services
docker-compose up -d

# Check health
curl http://localhost:3001/health

# View logs
docker-compose logs -f wallet-tracker
```

### Step 5: System Validation
```typescript
// src/wallet-tracker/scripts/validate-system.ts

async function validateSystem() {
  const validator = new SystemValidator();
  
  console.log('Running system validation...');
  
  const report = await validator.validateComplete();
  
  if (report.passed) {
    console.log('✅ System validation PASSED');
  } else {
    console.log('❌ System validation FAILED');
    console.log('Failed checks:');
    
    for (const [key, validation] of Object.entries(report.validations)) {
      if (!validation.passed) {
        console.log(`  - ${key}:`);
        validation.checks.forEach(check => {
          if (!check.passed) {
            console.log(`    ✗ ${check.name}: ${check.details}`);
          }
        });
      }
    }
  }
  
  // Save report
  await saveValidationReport(report);
  
  return report.passed;
}

validateSystem().then(passed => {
  process.exit(passed ? 0 : 1);
});
```

## Operational Procedures

### Daily Operations
```typescript
// src/wallet-tracker/operations/daily-tasks.ts

class DailyOperations {
  async runDailyTasks() {
    console.log(`Running daily tasks - ${new Date().toISOString()}`);
    
    // 1. Recalculate top wallet scores
    await this.recalculateTopWallets();
    
    // 2. Clean up old data
    await this.cleanupOldData();
    
    // 3. Refresh materialized views
    await this.refreshMaterializedViews();
    
    // 4. Generate performance report
    const report = await this.generateDailyReport();
    
    // 5. Backup critical data
    await this.backupData();
    
    console.log('Daily tasks completed');
    
    return report;
  }
}
```

### Monitoring Checklist
- [ ] All services running
- [ ] Database connections healthy
- [ ] Redis cache operational
- [ ] gRPC stream connected
- [ ] WebSocket server active
- [ ] API endpoints responsive
- [ ] Queue processing normal
- [ ] Error rate < 1%
- [ ] Latency < 100ms
- [ ] Signal accuracy > 70%

## Success Metrics

### System Performance
- Transaction processing: 10,000+ per minute
- Wallet scoring: 100+ per second
- Signal generation: < 1 second latency
- API response time: < 50ms p99
- Cache hit rate: > 80%
- System uptime: 99.9%

### Business Metrics
- Smart money wallets tracked: 1,000+
- Signal accuracy: > 70%
- Graduation prediction: > 50%
- False positive rate: < 10%
- Token coverage: > 80% of graduated tokens

## Deliverables

1. **Integrated System**: Full integration with Megatron
2. **Test Suite**: Comprehensive testing coverage > 80%
3. **Performance Report**: Benchmarks and optimization results
4. **Deployment Package**: Docker containers and configs
5. **Documentation**: Complete operational guides
6. **Monitoring Dashboard**: Real-time system metrics
7. **Validation Report**: System quality assurance

## Post-Launch Roadmap

### Week 1-2: Stabilization
- Monitor system performance
- Fix any critical bugs
- Tune parameters based on real data
- Gather user feedback

### Week 3-4: Optimization
- Implement performance improvements
- Enhance signal quality
- Add advanced features
- Expand wallet coverage

### Month 2: Enhancement
- Machine learning integration
- Advanced pattern detection
- Cross-chain wallet tracking
- Social correlation features

### Month 3: Scaling
- Horizontal scaling implementation
- Multi-region deployment
- Advanced caching strategies
- Real-time analytics platform