# Pump.fun Memecoin Trading Thesis: The 666 Score System

## Executive Summary

This thesis presents a systematic approach to trading memecoins on pump.fun, utilizing a dual-metric scoring system that evaluates both technical and holder characteristics to identify high-probability opportunities for 200-300% returns. The strategy employs disciplined position sizing based on token quality scores and strategic accumulation during the critical bonding curve phase.

## Core Strategy Overview

### Investment Philosophy
The strategy capitalizes on the predictable patterns of successful pump.fun launches by identifying tokens with strong technical momentum and favorable holder distribution metrics during the crucial 40-80% bonding curve completion phase. By systematically scoring tokens and scaling position sizes accordingly, we aim to maximize returns while managing downside risk.

### Target Returns
- **Primary Goal**: 200-300% returns per successful trade
- **Risk Management**: Position sizing scaled to token quality score
- **Time Horizon**: Short term holds (seconds to minutes to hours)

## The 666 Scoring System

### Technical Score (0-333 Points)

#### Key Metrics:
1. **Bonding Curve Progress** (0-83 points)
   - Optimal entry: 40-60% completion (full 83 points)
   - Acceptable: 60-80% completion (75-80 points)
   - Velocity of progression: 0.5-2% per hour ideal
   - Stability of curve advancement
   - **Critical Design Decision**: High progress (70-85%) maintains high scores to prevent premature selling as tokens approach graduation

2. **Market Cap Velocity** (0-100 points)
   - Optimal range: $15-30k market cap (60 points base)
   - Velocity bonus: up to 40 additional points
   - Rate of increase from launch
   - Volume-to-market cap ratio

3. **Trading Dynamics** (0-150 points)
   - Buy/sell pressure ratio (30 points)
   - Volume trends 5min vs 30min (25 points)
   - Whale concentration penalties (20 points)
   - Sell-off response scoring (-60 to +75 points)

### Holder Score (0-333 Points)

#### Key Metrics:
1. **Distribution Quality** (0-166 points)
   - **Gini Coefficient**: Measure of token concentration
   - **Top 10 Holders**: Target <30% ownership
   - **Top 25 Holders**: Target <60% ownership

2. **Wallet Analysis** (0-167 points)
   - **New vs. Old Wallet Ratio**: Preference for balanced mix
   - **Wallet Activity History**: Avoid known dumper wallets
   - **Organic Growth Pattern**: Natural distribution curve

## Entry Strategy

### Primary Entry Parameters
- **Market Cap Target**: $15,000 (≈80 SOL)
- **Bonding Curve Status**: 40% completion minimum
- **Accumulation Range**: $15,000 - $25,000 market cap  (40% to 80% BC progress)

### Position Building Protocol
1. **Initial Entry**: 0.1 SOL at qualifying score threshold
2. **Scaling Method**: 0.01 to 0.1 depending on score SOL intervals during accumulation zone
3. **Target Holdings**: 5-10 million tokens
4. **Maximum Position**: Up to 1 SOL

## Position Sizing Matrix

### Score-Based Allocation

| Token Score | Position Size | Risk Level | Target Return |
|------------|--------------|------------|---------------|
| 600-666 | Maximum (Full accumulation) | Low | 300%+ |
| 500-599 | 75% of maximum | Low-Medium | 250-300% |
| 400-499 | 50% of maximum | Medium | 200-250% |
| 300-399 | 25% of maximum | Medium-High | 200% |
| <300 | No entry | High | N/A |

## Exit Strategy

### Profit Taking Framework
1. **Tier 1 Exit** (200% gain): Sell 33% of position
2. **Tier 2 Exit** (250% gain): Sell additional 33%
3. **Tier 3 Exit** (300%+ gain): Liquidate remaining position or hold runner

### Risk Management Triggers
- **Stop Loss**: If token score drops below 250 post-entry
- **Time Stop**: Reassess if no movement within 1 hours
- **Bonding Curve Completion**: Partial exit on migration

## Risk Considerations

### Market Risks
- Rug pull potential
- Liquidity constraints
- Smart contract vulnerabilities
- Market manipulation

### Mitigation Strategies
1. Never invest more than affordable to lose
2. Diversify across multiple scored tokens
3. Maintain strict position sizing discipline
4. Monitor holder metrics continuously

## Scoring Philosophy & Critical Design Decisions

### Bonding Curve Progress Scoring Rationale

Our research revealed a critical insight: **penalizing high bonding curve progress (70-85%) causes premature position reduction**. When a token progresses from 70% to 85%, a declining score would trigger the automated system to reduce or exit positions—precisely when tokens are most likely to graduate and deliver maximum returns.

#### Progressive Scoring Distribution (Bonding Curve Component):
- **0% progress (launch)**: ~0/83 points - Tokens start at ZERO score
- **0-5% progress**: 0-15/83 points - Unproven tokens score near zero
- **5-20% progress**: 15-35/83 points - Gradual increase as token proves itself
- **20-35% progress**: 35-60/83 points - Building momentum phase
- **35-45% progress**: 60-75/83 points - Steep climb approaching optimal
- **45-55% progress**: 83/83 points - MAXIMUM SCORE at peak
- **55-65% progress**: 75-65/83 points - Gradual decline from peak
- **65-75% progress**: 65-50/83 points - Steeper decline signaling exit
- **>75% progress**: <50/83 points - Minimal score near graduation

### Why High Progress Maintains High Scores

1. **Prevents Algorithmic Selling**: Score degradation would trigger unwanted exits
2. **Graduation Proximity is Bullish**: 70-85% tokens often see acceleration
3. **Natural Exit at Migration**: Let graduation (100%) be the exit trigger, not score decay
4. **Thesis Alignment**: Hold positions through the entire 40-80% accumulation range

### Dynamic Sell-off Detection & Score Adjustment

The scoring system must detect and respond to market deterioration in real-time. When high sell volume or price drops occur, the technical score immediately adjusts downward to trigger position reduction or exit.

#### Sell-off Response Scoring (-60 to +75 points):
- **No sell pressure**: +40 to +75 points (bullish)
- **Minor dips (<5%)**: +20 to +40 points (normal volatility)
- **Moderate drops (5-15%)**: -10 to +20 points (caution)
- **Significant drops (15-30%)**: -30 to -10 points (exit signal)
- **Severe dumps (>30%)**: -60 to -30 points (immediate exit)

#### Real-time Detection Triggers:
1. **Whale Dumps**: Single sells >5 SOL trigger immediate score recalculation
2. **Coordinated Selling**: Multiple sells totaling >10 SOL in <1 minute
3. **Price Drops**: 
   - 5-minute: >10% drop
   - 15-minute: >15% drop  
   - 30-minute: >20% drop
4. **Volume Imbalance**: Sell volume >3x buy volume over 5 minutes
5. **Bonding Curve Reversal**: Progress decreasing (sells exceeding buys)

#### Score Response Times:
- **Normal conditions**: 5-second cache
- **Active sell-off**: 1-second updates
- **Critical events**: Immediate (no cache)

This ensures the system can exit positions quickly when market conditions deteriorate, as shown in tokens that pump to $60k then crash to $8k.

### Exit Triggers (Score-Independent)

The system should exit positions based on:
- **Actual graduation completion** (bonding curve reaches 100%)
- **Sell-off detection** (price drops >15-20% in short windows)
- **Profit targets achieved** (200-300% gains)
- **Time-based stops** (1-2 hour maximum hold)
- **Technical deterioration** (buy/sell ratio collapse, volume death)

**NOT** based on bonding curve progress increasing toward graduation.

## Implementation Framework

### Phase 1: Identification
- Monitor new token launches
- Apply initial technical screening
- Flag tokens meeting bonding curve criteria

### Phase 2: Scoring
- Calculate technical score (0-333)
- Calculate holder score (0-333)
- Generate composite score (0-666)

### Phase 3: Execution
- Enter positions based on score matrix
- Execute accumulation strategy
- Set automated alerts for exit triggers

### Phase 4: Management
- Monitor score changes in real-time
- Adjust position size if score improves
- Execute profit-taking according to framework

## Complete Scoring Breakdown

### Technical Score Components (333 points total)

1. **Bonding Curve Progress & Velocity (83 points)**
   - Position Score: 0-37.5 points (optimized for 40-60% progress)
   - Velocity Score: 0-33 points (0.5-2% per hour ideal)
   - Consistency Score: 0-12.5 points (stability metric)

2. **Market Cap Positioning (100 points)**
   - Base Position: 0-60 points ($15-30k optimal)
   - Velocity Bonus: 0-40 points (growth rate)

3. **Trading Health Metrics (75 points)**
   - Buy/Sell Ratio: 0-30 points
   - Volume Trends: 0-25 points
   - Whale Concentration: 0-20 points (penalties for concentration)

4. **Sell-off Response Score (75 points)**
   - Range: -60 to +75 points
   - Dynamic adjustment based on:
     - 5/15/30 minute price drops
     - Recovery strength
     - Consecutive red candles
     - Active sell-off duration

### Holder Score Components (333 points total)

1. **Distribution Metrics (111 points)**
   - Gini Coefficient: 0-40 points (<0.3 optimal)
   - Top 1% Concentration: 0-40 points (<5% optimal)
   - Unique Holder Count: 0-31 points (scaled by count)

2. **Wallet Quality (111 points)**
   - Bot Detection: 0-40 points (penalty for high bot ratio)
   - Smart Money Presence: 0-40 points (bonus for smart wallets)
   - Average Wallet Age: 0-31 points (>90 days optimal)

3. **Activity Metrics (111 points)**
   - Active Holders 24h: 0-40 points
   - Organic Growth Score: 0-40 points
   - Trading Velocity: 0-31 points

## Success Metrics

### Key Performance Indicators
- **Win Rate Target**: >70% of trades profitable
- **Average Return**: 200-300% on winning trades
- **Risk/Reward Ratio**: Minimum 1:3
- **Portfolio Turnover**: rapid. average hold less than 1-2 hours. 

## Implementation Summary: The Complete System

### Entry Prevention (0-45% Progress)
- **Tokens start at ZERO score** preventing FOMO on new launches
- **Progressive scoring** forces patience as tokens prove themselves
- **No entry below 45%** unless exceptional circumstances

### Optimal Entry (45-55% Progress)  
- **Maximum score of 83 points** at peak performance zone
- **$15-25k market cap** sweet spot for accumulation
- **Full position sizing** when all metrics align

### Hold Management (55-75% Progress)
- **Gradual score decline** signals profit-taking opportunities
- **NOT immediate exit** - allows for graduation run-up
- **Position reduction** based on score degradation

### Exit Triggers (Dynamic)
- **Sell-off detection** causes immediate score drops
- **Real-time monitoring** with 1-second updates during stress
- **Automatic position reduction** when scores fall below thresholds
- **Complete exit** on severe dumps or graduation

## Conclusion

The 666 Score System provides a quantitative framework for navigating the high-risk, high-reward environment of pump.fun memecoins. The progressive scoring curve prevents early FOMO by starting tokens at zero score, rewards patience by maximizing scores at 45-55% progress, and provides clear exit signals through both natural score decline and dynamic sell-off detection.

By combining technical momentum indicators with holder distribution analysis and real-time market response, the strategy aims to identify tokens with the highest probability of delivering 200-300% returns while maintaining disciplined risk management through score-based position sizing.

Success depends on:
1. **Patience**: Waiting for tokens to prove themselves (45%+ progress)
2. **Discipline**: Following score-based position sizing strictly
3. **Speed**: Responding to sell-offs within seconds, not minutes
4. **Adaptability**: Continuous refinement based on market feedback

This systematic approach transforms memecoin trading from gambling into a probabilistic edge-seeking strategy with clear entry, hold, and exit rules.