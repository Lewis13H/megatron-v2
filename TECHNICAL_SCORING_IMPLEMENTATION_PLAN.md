# Technical Scoring System Implementation Plan

## Overview
This document outlines the step-by-step implementation plan to update the technical scoring system to provide accurate, real-time scoring that reflects market conditions. The key changes include progressive scoring (starting at 0), peak scoring at 45-55%, and enhanced sell-off detection.

## Timeline: 2-3 Days Total

---

## Phase 1: Database Updates (Day 1)
**Goal**: Update scoring functions to implement progressive curve and enhanced sell-off detection

### 1.1 Apply Progressive Scoring Migration
**File**: `src/database/migrations/020_progressive_bonding_curve_scoring.sql`
**Status**: ✅ Created, needs deployment

```bash
# Run migration
npx tsx src/database/setup/apply-progressive-scoring.ts
```

**Key Changes**:
- Bonding curve scoring now starts at ~0 for new tokens
- Peak score at 45-55% progress (83 points max)
- Gradual decline after peak
- "Proof of life" multiplier for tokens <30% progress

### 1.2 Verify Existing Sell-off Detection
**Files**: 
- `src/database/migrations/016_enhanced_selloff_detection.sql` (already applied)
- `src/database/migrations/017_add_sell_pressure_tracking.sql` (check if applied)

```bash
# Check migration status
psql -U postgres -d megatron_v2 -c "SELECT * FROM migrations ORDER BY id DESC LIMIT 5;"
```

### 1.3 Create Combined Migration
**New File**: `src/database/migrations/021_complete_scoring_system.sql`

```sql
-- Combines all scoring improvements into one migration
-- Includes: progressive curve, sell-off detection, state tracking
```

---

## Phase 2: TypeScript Implementation (Day 1-2)
**Goal**: Update scoring services to match database functions

### 2.1 Update Technical Score Calculator
**File**: `src/scoring/technical-score-calculator.ts`

**Required Changes**:
```typescript
// Add progressive scoring logic
- Start tokens at 0 score when BC progress < 5%
- Implement bell curve peaking at 50%
- Add multipliers for "unproven" tokens
```

### 2.2 Integrate Progressive Bonding Curve
**File**: `src/scoring/progressive-bonding-curve.ts` ✅ Created

**Integration Points**:
- Import into technical-score-calculator.ts
- Replace existing bonding curve calculation
- Add position size multiplier logic

### 2.3 Enhance Sell-off Response
**File**: `src/scoring/selloff-detector.ts` (create new)

```typescript
export class SelloffDetector {
  // Real-time sell pressure tracking
  // Whale dump detection (>5 SOL)
  // Coordinated selling detection
  // Dynamic cache TTL adjustment
}
```

---

## Phase 3: Monitor Integration (Day 2)
**Goal**: Connect monitors to new scoring system

### 3.1 Update Price Monitor
**File**: `src/monitors/pumpfun/pumpfun-price-monitor.ts`

**Changes**:
- Trigger immediate score recalculation on price drops >10%
- Bypass cache for critical events
- Track cumulative sell volume

### 3.2 Update Transaction Monitor  
**File**: `src/monitors/pumpfun/pumpfun-transaction-monitor.ts`

**Changes**:
- Detect whale dumps (>5 SOL sells)
- Track sell/buy ratio in real-time
- Alert on coordinated selling patterns

### 3.3 Create Score Monitor
**File**: `src/monitors/score-monitor.ts` (new)

```typescript
// Dedicated monitor for score changes
// Tracks score progression for all active tokens
// Generates alerts on significant changes
// Logs scoring events for analysis
```

---

## Phase 4: Testing & Validation (Day 3)
**Goal**: Ensure scoring works correctly with live data

### 4.1 Create Test Suite
**File**: `src/tests/scoring-system.test.ts`

**Test Cases**:
1. **New Token Launch**: Should score ~0
2. **Progressive Growth**: Score increases 0→45%
3. **Optimal Entry**: Max score at 45-55%
4. **Sell-off Response**: Score drops on dumps
5. **Recovery**: Score improves after sell-off

### 4.2 Historical Data Validation
```bash
# Test with historical tokens that graduated
npx tsx src/scripts/test-graduated-tokens.ts

# Test with tokens that rugged
npx tsx src/scripts/test-rugged-tokens.ts
```

### 4.3 Live Testing
```bash
# Monitor live tokens for 24 hours
npm run score:monitor:verbose

# Track score changes in real-time
npm run score:track
```

---

## Phase 5: Dashboard Updates (Day 3-4)
**Goal**: Visualize new scoring system

### 5.1 Update API Endpoints
**File**: `src/api/dashboard-api.ts`

**New Endpoints**:
- `/api/scores/progressive/:tokenId` - Get score curve
- `/api/scores/optimal-entry` - List tokens at 45-55%
- `/api/scores/sell-alerts` - Active sell-offs

### 5.2 Update Dashboard UI
**File**: `dashboard/index.html`

**New Features**:
- Score progression chart (bell curve visualization)
- Current score distribution by progress range
- Sell-off alerts panel
- Real-time score updates

### 5.3 Create Monitoring Views
```sql
-- SQL views for dashboard
CREATE VIEW optimal_entry_tokens_live AS ...
CREATE VIEW selloff_alerts_active AS ...
CREATE VIEW score_progression_hourly AS ...
```

---

## Phase 6: Monitoring & Alerting (Day 3)
**Goal**: Real-time monitoring of score changes and market events

### 6.1 Score Change Monitoring
```typescript
enum ScoreEvent {
  NEW_TOKEN,          // Token launched (score ~0)
  ENTERING_OPTIMAL,   // Approaching 45% progress
  AT_PEAK,           // In 45-55% zone (max score)
  DECLINING,         // Past peak, score dropping
  SELL_PRESSURE,     // Detected selling activity
  WHALE_DUMP,        // >5 SOL sell detected
  RECOVERY,          // Bouncing after sell-off
}
```

### 6.2 Monitoring Outputs
- Console logging with severity levels
- Database storage for analysis
- Dashboard real-time updates
- Score progression tracking

---

## Phase 7: Documentation & Deployment (Day 3)
**Goal**: Document changes and deploy to production

### 8.1 Update Documentation
- [x] `pump-fun-trading-thesis.md` - Updated with new scoring
- [ ] `TECHNICAL_SCORE_ANALYSIS.md` - Update with progressive curve
- [ ] `README.md` - Add scoring system overview
- [ ] `CLAUDE.md` - Update development commands

### 8.2 Deployment Checklist
```bash
# 1. Backup database
pg_dump megatron_v2 > backup_$(date +%Y%m%d).sql

# 2. Run migrations
npm run db:migrate

# 3. Restart monitors
npm run monitors:restart

# 4. Verify scoring
npm run score:verify

# 5. Monitor for 1 hour
npm run score:monitor:health
```

---

## Implementation Commands

### Quick Start
```bash
# Apply all scoring updates
npm run scoring:upgrade

# Test with live data
npm run scoring:test:live

# Monitor performance
npm run scoring:monitor
```

### Rollback Plan
```bash
# If issues arise, rollback to previous version
npm run scoring:rollback

# Restore from backup
psql -U postgres -d megatron_v2 < backup_YYYYMMDD.sql
```

---

## Success Metrics

### Technical Metrics
- [ ] Tokens at 0% progress score <10 points
- [ ] Tokens at 50% progress score 75-83 points  
- [ ] Sell-off detection triggers within 1 second
- [ ] Score updates complete in <100ms
- [ ] Progressive curve matches design (bell curve)
- [ ] Cache invalidation works during sell-offs
- [ ] Score changes reflect market conditions accurately

---

## Risk Mitigation

### Potential Issues & Solutions

1. **Score calculations too slow**
   - Solution: Add materialized views
   - Cache frequently accessed scores
   - Optimize SQL functions

2. **Too many false sell-off signals**
   - Solution: Tune sensitivity thresholds
   - Add confirmation period
   - Weight by volume significance

3. **Progressive curve not smooth**
   - Solution: Add interpolation between ranges
   - Fine-tune multipliers
   - Test with more data points

4. **Database performance degradation**
   - Solution: Partition technical_scores table
   - Archive old data
   - Add indexes on hot paths

---

## Monitoring & Maintenance

### Daily Tasks
- Review score distribution across progress ranges
- Check sell-off detection accuracy
- Monitor score calculation performance
- Validate scoring curve shape

### Weekly Tasks
- Analyze scoring patterns
- Tune parameters based on observations
- Review false positive/negative rates
- Update threshold values if needed

### Monthly Tasks
- Full system performance review
- Historical pattern analysis
- Parameter optimization
- Scoring formula refinement

---

## Next Steps

1. **Immediate** (Today):
   - [ ] Review this plan with team
   - [ ] Set up test environment
   - [ ] Begin Phase 1 implementation

2. **This Week**:
   - [ ] Complete Phases 1-5
   - [ ] Begin live testing
   - [ ] Gather initial metrics

3. **Next Week**:
   - [ ] Complete Phases 6-8
   - [ ] Full production deployment
   - [ ] Monitor and optimize

---

## Appendix: Key Files to Modify

### Database
- ✅ `020_progressive_bonding_curve_scoring.sql`
- [ ] `021_complete_scoring_system.sql`

### TypeScript
- [ ] `src/scoring/technical-score-calculator.ts`
- ✅ `src/scoring/progressive-bonding-curve.ts`
- [ ] `src/scoring/selloff-detector.ts`

### Monitors
- [ ] `src/monitors/pumpfun/pumpfun-price-monitor.ts`
- [ ] `src/monitors/pumpfun/pumpfun-transaction-monitor.ts`
- [ ] `src/monitors/score-monitor.ts`

### API & Dashboard
- [ ] `src/api/dashboard-api.ts`
- [ ] `dashboard/index.html`
- [ ] `dashboard/js/scoring-charts.js`

---

## Contact & Support

For questions or issues during implementation:
- Check `TECHNICAL_SCORE_ANALYSIS.md` for detailed scoring logic
- Review `pump-fun-trading-thesis.md` for strategy alignment
- Test changes in development environment first
- Document any deviations from this plan