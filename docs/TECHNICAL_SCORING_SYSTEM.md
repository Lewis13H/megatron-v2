# Technical Scoring System for Pump.fun Tokens

## Overview

The Technical Scoring System is a comprehensive, real-time evaluation framework that assigns scores from 0-333 points to pump.fun tokens based on market dynamics, trading health, and sell-off resistance. The system is optimized for identifying tokens in the $15-30k market cap range - the optimal entry point for maximum returns.

## Score Components (333 Points Total)

### 1. Market Cap & Entry Optimization (100 points)

**Position Score (60 points)**
- $15,000 - $30,000: 60 points ⭐ *Optimal entry zone*
- $10,000 - $15,000: 40 points
- $30,000 - $50,000: 40 points
- $5,000 - $10,000: 20 points
- $50,000 - $100,000: 20 points
- Outside range: 0 points

**Velocity Score (40 points)**
- 0.5-2% growth per minute: 40 points
- 0.2-0.5% or 2-3% per minute: 25 points
- Other positive growth: 10 points
- Stagnant/negative: 0 points

### 2. Bonding Curve Dynamics (83 points)

**Progress Velocity (33 points)**
- Measures how quickly the token progresses through bonding curve milestones
- Optimal: 0.5-2% progress per hour
- Penalizes both too-slow and too-fast progression

**Progress Consistency (25 points)**
- Evaluates stability of progression rate
- Lower variance = higher score
- Currently uses default value, will improve with more historical data

**Current Position (25 points)**
- 5-20% progress: 25 points ⭐ *Sweet spot*
- 20-40% progress: 20 points
- 0-5% progress: 15 points
- 40-60% progress: 10 points
- >60% progress: 5 points

### 3. Trading Health Metrics (75 points)

**Buy/Sell Ratio (30 points)**
- Ratio > 2.0: 30 points
- Ratio 1.5-2.0: 20 points
- Ratio 1.0-1.5: 10 points
- Ratio < 1.0: 0 points

**Volume Trend (25 points)**
- Compares 5-minute volume to 30-minute average
- >50% increase: 25 points
- >20% increase: 20 points
- Any increase: 10 points
- Decrease: 0 points

**Transaction Distribution (20 points)**
- Whale concentration <10%: 20 points
- Whale concentration <20%: 15 points
- Whale concentration <30%: 10 points
- Whale concentration <40%: 5 points
- Whale concentration ≥40%: 0 points

### 4. Sell-off Detection & Response (75 points)

**Sell Pressure Score (-40 to 40 points)**
- No price drop: 40 points
- <10% drop in 5min: 30 points
- <20% drop: 10 points
- <30% drop: -10 points
- <40% drop: -25 points
- ≥40% drop: -40 points ⚠️ *Maximum penalty*

**Recovery Strength (35 points)**
- Measures buy volume response after price drops
- Recovery ratio >2.0: 35 points
- Recovery ratio >1.5: 25 points
- Recovery ratio >1.0: 15 points
- Recovery ratio >0.5: 5 points
- No recovery: 0 points

## Key Features

### 1. Real-time Updates
- Scores update with every significant transaction
- 5-second cache for performance optimization
- Debounced calculations to prevent excessive database load

### 2. Sell-off Detection
- Immediate score recalculation on large sells (>1 SOL)
- Dynamic penalties based on price drop severity
- Recovery strength measurement

### 3. Velocity Metrics
- Market cap velocity (% change per minute)
- Bonding curve progress velocity (% per hour)
- Volume trend analysis across multiple timeframes

### 4. Historical Tracking
- All scores saved as time-series data
- Compression for older data (>1 day)
- Ability to query historical scores for trend analysis

## Implementation Details

### Database Schema

**technical_scores table (hypertable)**
```sql
- id: UUID (primary key)
- token_id: UUID (foreign key)
- pool_id: UUID (foreign key)
- total_score: NUMERIC(5,2)
- market_cap_score: NUMERIC(5,2)
- bonding_curve_score: NUMERIC(5,2)
- trading_health_score: NUMERIC(5,2)
- selloff_response_score: NUMERIC(5,2)
- market_cap_usd: NUMERIC(20,2)
- bonding_curve_progress: NUMERIC(5,2)
- buy_sell_ratio: NUMERIC(10,2)
- is_selloff_active: BOOLEAN
- calculated_at: TIMESTAMPTZ
```

### Key Functions

**calculate_technical_score(token_id, pool_id)**
- Main scoring function that calculates all components
- Returns complete score breakdown
- Uses real-time data from pools and transactions

**save_technical_score(token_id, pool_id)**
- Saves score snapshot for historical tracking
- Called on significant score changes

### TypeScript API

```typescript
// Calculate current score
const score = await technicalScoreCalculator.calculateScore(tokenId, poolId);

// Get detailed breakdown
const breakdown = await technicalScoreCalculator.getScoreBreakdown(tokenId, poolId);

// Get historical scores
const history = await technicalScoreCalculator.getHistoricalScores(tokenId, 24);

// Monitor score changes
technicalScoreCalculator.monitorScoreChanges((tokenId, oldScore, newScore) => {
  console.log(`Score changed from ${oldScore} to ${newScore}`);
});
```

### Integration with Monitors

The system integrates with existing pump.fun monitors:

1. **New Token Monitor**: Calculates initial score after 10 seconds
2. **Price Monitor**: Updates score on price changes (debounced)
3. **Account Monitor**: Updates on bonding curve milestones
4. **Transaction Monitor**: Immediate updates for large transactions

## Usage Examples

### Finding Optimal Entry Tokens
```typescript
const optimalTokens = await pumpfunIntegration.getOptimalEntryTokens();
// Returns tokens with $15-30k market cap and score >200
```

### Detecting Sell-offs
```typescript
const selloffTokens = await pumpfunIntegration.getSelloffTokens();
// Returns tokens currently experiencing sell-offs with recovery metrics
```

### Monitoring Score Changes
```typescript
pumpfunIntegration.on('scoreChange', (event) => {
  if (event.newScore - event.oldScore <= -20) {
    console.log(`⚠️ Major score drop detected for ${event.tokenId}`);
  }
});
```

## Performance Considerations

1. **Caching**: 5-second cache for score calculations
2. **Debouncing**: Prevents excessive recalculation during high activity
3. **Batch Processing**: Efficient queries using window functions
4. **Hypertable**: TimescaleDB for optimal time-series performance
5. **Compression**: Automatic compression for data >1 day old

## Future Enhancements

1. **Machine Learning Integration**
   - Use historical scores to predict graduation probability
   - Pattern recognition for pump & dump detection

2. **Enhanced Consistency Scoring**
   - Calculate standard deviation of progress rate
   - Identify erratic vs smooth progression patterns

3. **Social Score Integration**
   - Combine with social metrics for comprehensive scoring
   - Weight adjustments based on social momentum

4. **Advanced Sell-off Detection**
   - Multi-timeframe analysis
   - Coordinated sell detection
   - Whale wallet tracking

## Monitoring Dashboard Integration

The scoring system can be visualized in the dashboard:

```typescript
// Add to dashboard API
app.get('/api/technical-scores', async (req, res) => {
  const scores = await pumpfunIntegration.getTokensByScoreRange(
    req.query.minScore || 0,
    req.query.maxScore || 333
  );
  res.json(scores);
});
```

## Conclusion

The Technical Scoring System provides a comprehensive, data-driven approach to evaluating pump.fun tokens with particular emphasis on:

1. **Optimal Entry Detection**: Heavy bias toward $15-30k market cap range
2. **Real-time Responsiveness**: Immediate reaction to market events
3. **Sell-off Protection**: Dynamic penalties and recovery measurement
4. **Velocity Analysis**: Time-based progression metrics
5. **Historical Intelligence**: Learning from past performance

This system enables automated identification of high-potential tokens while avoiding common pitfalls like pump & dumps, whale manipulation, and coordinated sell-offs.