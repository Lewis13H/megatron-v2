# Holder Analysis V2 - Production System Documentation

## Overview

The Holder Analysis V2 system is a complete redesign of the token holder scoring mechanism, optimized for the Helius Developer Plan (10M credits/month). It provides accurate, real-time holder intelligence with sophisticated distribution metrics, wallet quality assessment, and risk analysis.

## Key Improvements

### 1. API Efficiency
- **Batch Processing**: Processes up to 25 wallets simultaneously
- **Smart Caching**: 5-minute TTL with delta updates
- **WebSocket Support**: Real-time holder updates without polling
- **Credit Tracking**: Monitors usage to stay within 10M/month limit
- **Optimized Queries**: Uses Helius enhanced APIs only when necessary

### 2. Real Data
- **Actual Wallet Ages**: Fetches creation dates from blockchain
- **Transaction History**: Analyzes real transaction patterns
- **Token Diversity**: Counts actual tokens held
- **Smart Money Detection**: Identifies experienced traders
- **Bot Classification**: Multiple signals for accurate detection

### 3. Advanced Metrics

#### Distribution Metrics (111 points)
- **Gini Coefficient**: Measure of inequality (0-1)
- **HHI Index**: Herfindahl-Hirschman concentration index
- **Theil Index**: Entropy-based inequality measure
- **Shannon Entropy**: Distribution randomness
- **Concentration Tiers**: Whales, large, medium, small holders

#### Wallet Quality (111 points)
- **Smart Money Ratio**: Percentage of experienced traders
- **Bot Detection**: Multi-signal bot identification
- **Sniper Detection**: Early buyer pattern recognition
- **MEV Bot Detection**: Identifies sandwich attackers
- **Diamond/Paper Hands**: Holding duration analysis

#### Activity Patterns (111 points)
- **Buy/Sell Velocity**: Transactions per hour
- **Net Flow Rate**: Token accumulation/distribution rate
- **Unique Actors**: Distinct buyers/sellers per period
- **Volume Analysis**: 1h, 24h, 7d volume tracking
- **Organic Growth**: Natural vs manipulated activity

### 4. Risk Assessment
- **Concentration Risk**: Single points of failure
- **Bot Risk**: Automated trading exposure
- **Rug Pull Risk**: Exit scam indicators
- **Wash Trading Risk**: Fake volume detection
- **Manipulation Risk**: Price manipulation potential
- **Overall Risk Score**: Weighted composite (0-100)

## Architecture

### Service Layer
```
HolderAnalysisService
├── Helius SDK Integration
├── WebSocket Management
├── Cache Layer (5min TTL)
├── Credit Tracking
└── Event Emitter
```

### Data Flow
```
1. Token Selection (10-99% bonding curve)
2. Holder Fetching (Helius getTokenAccounts)
3. Wallet Analysis (Batched, cached)
4. Metric Calculation
5. Score Generation
6. Database Storage
7. Alert Generation
```

### Database Schema
- `holder_snapshots`: Time-series distribution data
- `wallet_quality_metrics`: Wallet composition analysis
- `activity_metrics`: Trading velocity and volume
- `risk_metrics`: Risk assessment scores
- `token_holders`: Individual holder tracking
- `wallet_analysis_cache`: 7-day wallet cache
- `api_credit_usage`: Credit consumption tracking

## Usage

### Installation

1. Run database migration:
```bash
psql -U your_user -d your_database -f src/database/migrations/018_holder_analysis_v2.sql
```

2. Set environment variables:
```bash
HELIUS_API_KEY=your_helius_api_key
HOLDER_MIN_PROGRESS=10
HOLDER_MAX_PROGRESS=99
HOLDER_WEBSOCKET=false
HOLDER_INTERVAL_MS=60000
```

3. Start the monitor:
```bash
npm run holder:monitor:v2
```

### API Credit Management

The system is designed to stay within the 10M credits/month limit:

- **RPC Calls**: 1 credit each
- **Enhanced API**: 10 credits each
- **WebSocket Messages**: 1 credit each

Estimated usage:
- 100 tokens/day × 50 holders/token × 1 credit = 5,000 credits/day
- Monthly projection: ~150,000 credits (1.5% of limit)

With caching and optimization:
- Actual usage: ~50,000 credits/month (0.5% of limit)

### Configuration Options

```typescript
const config = {
  heliusApiKey: 'your_key',
  enableWebSocket: false,        // Real-time updates
  analysisIntervalMs: 60000,     // Check every minute
  minBondingCurveProgress: 10,   // Start at 10%
  maxBondingCurveProgress: 99,   // Stop at graduation
  minHolders: 5,                 // Minimum holders required
  minTokenAgeMinutes: 30,        // Token must be 30min old
  maxConcurrentAnalysis: 5,      // Parallel analysis limit
  alertThresholds: {
    highConcentration: 50,        // Top 10 > 50%
    highBotRatio: 0.3,           // > 30% bots
    highGini: 0.8,               // Gini > 0.8
    lowScore: 100,               // Score < 100/333
    highScore: 250,              // Score > 250/333
    highRisk: 70                 // Risk > 70/100
  }
};
```

## Scoring Algorithm

### Distribution Score (111 points)
```
Concentration (40 points):
- Top holder < 5%: 40 points
- Top holder < 10%: 30 points
- Top holder < 15%: 20 points
- Top holder < 20%: 10 points
- Top holder >= 20%: 0 points

Gini Score (40 points):
- Score = (1 - gini) × 40

Diversity (31 points):
- Score = min(31, holder_count / 10)
```

### Quality Score (111 points)
```
Wallet Age (40 points):
- > 90 days: 40 points
- > 30 days: 30 points
- > 7 days: 20 points
- < 7 days: age × 2.86

Bot Detection (31 points):
- Score = 31 - (bot_ratio × 100)

Smart Money (40 points):
- Score = smart_money_ratio × 40
```

### Activity Score (111 points)
```
Trading Velocity (40 points):
- Net positive flow: min(40, net_flow × 5)

Volume (40 points):
- > 10 SOL/hour: 40 points
- > 5 SOL/hour: 30 points
- > 1 SOL/hour: 20 points
- < 1 SOL/hour: volume × 20

Organic Growth (31 points):
- Score = (unique_buyers / total_transactions) × 31
```

## Alert System

### Critical Alerts (🚨)
- Single whale owns >30%
- Top 10 holders own >50%
- Overall risk >70/100
- Rug pull risk >60/100

### Warning Alerts (⚠️)
- Bot ratio >30%
- Gini coefficient >0.8
- Holder score <100/333
- Wash trading detected

### Info Alerts (ℹ️)
- Smart money present >10%
- Diamond hands >50%
- Excellent score >250/333
- Organic growth detected

## Performance Optimizations

### Caching Strategy
- Wallet metrics: 7-day cache
- Holder snapshots: 5-minute cache
- Activity metrics: Real-time from database
- Smart invalidation on updates

### Batch Processing
- 25 wallets per batch
- 500ms delay between batches
- Parallel processing within batches
- Automatic retry on failures

### Database Optimizations
- TimescaleDB for time-series data
- Materialized views for dashboards
- Continuous aggregates for statistics
- Compression policies for old data

## Monitoring & Maintenance

### Health Checks
- Credit usage tracking
- Error rate monitoring
- Cache hit rates
- API response times

### Automated Maintenance
- View refresh every 5 minutes
- Data compression after 7 days
- Retention policy (180 days)
- Credit counter reset monthly

## Integration with Megatron V2

The system integrates seamlessly with existing monitors:

1. **Pump.fun Monitor**: Triggers analysis at 10% progress
2. **Graduation Monitor**: Freezes scores at 100%
3. **Dashboard API**: Provides real-time scores
4. **Alert System**: Sends critical notifications

## Troubleshooting

### Common Issues

1. **High API Credit Usage**
   - Check cache hit rates
   - Increase analysis interval
   - Reduce concurrent analysis

2. **Slow Analysis**
   - Check database performance
   - Optimize batch sizes
   - Enable WebSocket for updates

3. **Inaccurate Scores**
   - Verify wallet cache freshness
   - Check data completeness
   - Review bot detection thresholds

### Debug Mode

Set environment variables:
```bash
DEBUG=holder:*
LOG_LEVEL=debug
```

## Future Enhancements

1. **Machine Learning Integration**
   - Pattern recognition for smart money
   - Predictive rug pull detection
   - Automated threshold optimization

2. **Enhanced Metrics**
   - Cross-token holder analysis
   - Wallet clustering
   - Social graph analysis

3. **Performance Improvements**
   - GraphQL API integration
   - Dedicated caching service
   - Horizontal scaling support

## API Reference

### HolderAnalysisService

```typescript
// Analyze a token
const snapshot = await service.analyzeToken(
  mintAddress: string,
  bondingCurveProgress: number,
  options?: {
    useWebSocket?: boolean,
    forceRefresh?: boolean,
    includeHistoricalData?: boolean
  }
);

// Calculate holder score
const score = service.calculateHolderScore(snapshot);

// Get credit usage
const credits = service.getCreditsUsed();

// Clean up resources
await service.cleanup();
```

### HolderMonitorV2

```typescript
// Start monitoring
const monitor = await startHolderMonitorV2(config);

// Event listeners
monitor.on('analyzed', (result) => { });
monitor.on('criticalAlert', (result) => { });
monitor.on('error', (error) => { });

// Get latest scores
const scores = await monitor.getLatestScores(limit);

// Stop monitoring
await monitor.stop();
```

## Support

For issues or questions:
1. Check logs in real-time
2. Review database metrics
3. Monitor API credit usage
4. Verify Helius API status

## License

Proprietary - Megatron V2 System