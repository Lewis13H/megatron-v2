# Holder Score Implementation Guide

## Overview

The Holder Score system analyzes token distribution health for Pump.fun tokens when they reach 10-25% bonding curve progress. This critical window provides early signals about token quality and organic growth potential.

## System Components

### 1. Database Tables (Migration 014)
- `holder_snapshots` - Time-series distribution metrics
- `token_holders` - Individual wallet tracking
- `holder_scores` - Calculated scores and alerts
- `wallet_analysis_cache` - Performance optimization

### 2. Helius API Integration
- Token holder fetching with pagination
- Wallet analysis (age, activity, risk)
- Distribution metrics calculation
- Batch processing for efficiency

### 3. Holder Score Analyzer
- 333-point scoring system
- Distribution (111 pts), Quality (111 pts), Activity (111 pts)
- Bot detection algorithms
- Organic growth analysis

### 4. Monitoring Service
- Automatic snapshot collection
- Real-time score calculation
- Alert generation
- Dashboard integration

## Setup Instructions

### 1. Environment Variables
```bash
# Required
HELIUS_API_KEY=your_helius_api_key

# Optional
RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_key
HOLDER_SCORE_INTERVAL=5  # Minutes between checks
```

### 2. Database Migration
```bash
# Run the holder tracking tables migration
npm run db:migrate:holder

# Or manually
psql -U postgres -d megatron_v2 -f src/database/migrations/014_create_holder_tracking_tables.sql
```

### 3. Install Dependencies
```bash
npm install
```

## Usage

### Start Holder Score Monitor
```bash
npm run holder:monitor
```

This will:
- Monitor tokens with 10-25% bonding curve progress
- Collect holder snapshots every 5 minutes
- Calculate and save holder scores
- Display real-time statistics and alerts

### Test Individual Token
```bash
# Test a specific token
npm run test:holder <token_mint_address>

# Example
npm run test:holder EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Test multiple eligible tokens
npm run test:holder --multiple
```

### Monitor Output Example
```
🚀 Starting Holder Score Monitoring Service
📊 Analysis window: 10-25% bonding curve progress
⏱️  Check interval: 5 minutes

✅ Database connection established
✅ Holder snapshot service started

📊 HOLDER SCORE STATISTICS
══════════════════════════════════════════════════
Eligible tokens (10-25% progress): 42
Scores calculated (last hour): 12
Average score: 187/333
Best score: 267/333
Worst score: 89/333

🏆 TOP SCORED TOKENS (24h)
──────────────────────────────────────────────────
1. BONK - 267/333
   Progress: 18.5% | Holders: 842 | Gini: 0.421 | Bots: 8.2%
2. MEOW - 241/333
   Progress: 22.1% | Holders: 623 | Gini: 0.512 | Bots: 12.1%

🚨 RECENT ALERTS
──────────────────────────────────────────────────
❌ SCAM: HIGH CONCENTRATION: Top 10 holders own 78.2%
✅ GOOD: STRONG HOLDER BASE: Score 251/333
```

## Scoring Breakdown

### Distribution Score (111 points)
- **Concentration Risk (40 pts)**: Gini coefficient, HHI index
- **Whale Detection (40 pts)**: Single wallet limits, connected wallets
- **Distribution Velocity (31 pts)**: New holder growth rate

### Quality Score (111 points)
- **Wallet Age & History (40 pts)**: Account age, transaction count, ENS
- **Diamond Hand Analysis (40 pts)**: Historical holding patterns
- **Bot Detection (31 pts)**: Multiple signals for automated wallets

### Activity Score (111 points)
- **Organic Growth (40 pts)**: Natural vs artificial patterns
- **Transaction Diversity (40 pts)**: DEX usage, size variance
- **Network Effects (31 pts)**: Holder interconnections

## Alert Thresholds

### Red Flags (Automatic Disqualification)
- Single wallet owns >15%
- Bot ratio >30%
- Gini coefficient >0.8
- Top 10 concentration >50%

### Yellow Flags (Score Penalties)
- Single wallet owns >10%
- Bot ratio >20%
- Low average wallet age (<7 days)
- Poor distribution velocity

### Positive Signals (Score Bonuses)
- Total score >250/333
- Average wallet age >60 days
- Bot ratio <10%
- Organic growth score >80%

## API Integration

### Get Latest Holder Scores
```typescript
import { getLatestHolderScore } from '../database/monitor-integration';

const score = await getLatestHolderScore('token_mint_address');
console.log(`Score: ${score.total_score}/333`);
```

### Get Score History
```typescript
import { getHolderScoreHistory } from '../database/monitor-integration';

const history = await getHolderScoreHistory('token_mint_address', 24);
history.forEach(score => {
  console.log(`${score.score_time}: ${score.total_score}/333`);
});
```

### Direct Analysis
```typescript
import { HolderScoreAnalyzer } from '../scoring/holder-score-implementation';

const analyzer = new HolderScoreAnalyzer(heliusApiKey, rpcUrl);
const score = await analyzer.analyzeToken(mintAddress, bondingCurveProgress);
```

## Performance Considerations

1. **API Rate Limits**: Helius API has rate limits, system implements delays
2. **Batch Processing**: Processes 5 tokens concurrently
3. **Caching**: Wallet analysis cached to reduce API calls
4. **Time-Series**: Uses TimescaleDB for efficient storage

## Troubleshooting

### Common Issues

1. **"HELIUS_API_KEY environment variable is required"**
   - Set your Helius API key in .env file

2. **"Insufficient holders (minimum 50 required)"**
   - Token needs at least 50 holders for meaningful analysis

3. **"Token not eligible for holder scoring"**
   - Only tokens with 10-25% bonding curve progress are analyzed

4. **Database connection errors**
   - Ensure PostgreSQL is running
   - Check database credentials in .env

### Debug Mode
```bash
# Enable debug logging
DEBUG=holder:* npm run holder:monitor
```

## Future Enhancements

1. **Machine Learning Integration**
   - Train models on historical holder data
   - Predict graduation probability
   - Detect sophisticated bot patterns

2. **Real-time Alerts**
   - Webhook notifications
   - Telegram/Discord integration
   - Email alerts for high scores

3. **Advanced Analytics**
   - Wallet clustering analysis
   - Social graph integration
   - Cross-chain wallet history

4. **Performance Optimizations**
   - Redis caching layer
   - Parallel processing improvements
   - Stream processing for real-time updates