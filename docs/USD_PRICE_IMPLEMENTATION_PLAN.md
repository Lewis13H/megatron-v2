# USD Price Implementation Plan

## Overview

This document outlines the implementation strategy for adding USD price tracking to the Megatron V2 system. Currently, all prices are denominated in SOL. Adding USD pricing will provide better context for traders and enable more meaningful performance metrics.

## Architecture Design

### 1. Data Sources for SOL/USD Price

#### Primary Options:
1. **Pyth Network** (Recommended)
   - On-chain price oracle on Solana
   - Real-time price updates
   - High reliability and low latency
   - Price feed address: `H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG`

2. **Jupiter Price API**
   - REST API: `https://price.jup.ag/v4/price?ids=So11111111111111111111111111111111111111112`
   - Simple integration
   - Good for batch price lookups

3. **Birdeye API**
   - Comprehensive price data
   - Historical prices available
   - Requires API key

4. **CoinGecko/CoinMarketCap**
   - Good for historical data
   - Rate limits on free tier
   - Higher latency

### 2. Database Schema Changes

#### New Tables

```sql
-- Historical SOL/USD prices for backtesting and historical calculations
CREATE TABLE sol_usd_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    price_time TIMESTAMPTZ NOT NULL,
    price_usd NUMERIC(20,6) NOT NULL,
    source VARCHAR(50) NOT NULL, -- 'pyth', 'jupiter', 'birdeye', etc.
    confidence NUMERIC(20,6), -- Pyth confidence interval
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(price_time, source)
);

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('sol_usd_prices', 'price_time');

-- Index for efficient lookups
CREATE INDEX idx_sol_usd_prices_time ON sol_usd_prices(price_time DESC);

-- Continuous aggregate for SOL/USD candles
CREATE MATERIALIZED VIEW sol_usd_candles_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', price_time) AS bucket,
    first(price_usd, price_time) AS open,
    max(price_usd) AS high,
    min(price_usd) AS low,
    last(price_usd, price_time) AS close,
    avg(price_usd) AS average,
    count(*) AS sample_count
FROM sol_usd_prices
GROUP BY time_bucket('1 minute', price_time);
```

#### Schema Modifications

```sql
-- Add USD columns to price_candles_1m
ALTER TABLE price_candles_1m 
ADD COLUMN open_usd NUMERIC(30,6),
ADD COLUMN high_usd NUMERIC(30,6),
ADD COLUMN low_usd NUMERIC(30,6),
ADD COLUMN close_usd NUMERIC(30,6),
ADD COLUMN volume_usd NUMERIC(20,2);

-- Add USD price to transactions
ALTER TABLE transactions
ADD COLUMN price_per_token_usd NUMERIC(30,6),
ADD COLUMN sol_amount_usd NUMERIC(20,2);
```

### 3. Implementation Components

#### A. SOL/USD Price Fetcher Service

```typescript
// src/services/sol-price-service.ts
interface SolPriceService {
  getCurrentPrice(): Promise<number>;
  getHistoricalPrice(timestamp: Date): Promise<number>;
  subscribeToUpdates(callback: (price: number) => void): void;
  unsubscribe(): void;
}

// Implementation for Pyth Network
class PythSolPriceService implements SolPriceService {
  private connection: Connection;
  private pythClient: PythHttpClient;
  private currentPrice: number = 0;
  private priceSubscription?: number;

  async initialize() {
    // Connect to Pyth price feed
    // Set up real-time subscription
    // Cache current price
  }

  async getCurrentPrice(): Promise<number> {
    // Return cached price or fetch latest
  }

  async getHistoricalPrice(timestamp: Date): Promise<number> {
    // Query sol_usd_prices table
    // Interpolate if exact timestamp not found
  }
}
```

#### B. Price Update Worker

```typescript
// src/workers/sol-price-updater.ts
class SolPriceUpdater {
  private priceService: SolPriceService;
  private updateInterval: number = 5000; // 5 seconds

  async start() {
    // Subscribe to price updates
    // Store prices in sol_usd_prices table
    // Update existing records with USD values
  }

  async backfillHistoricalPrices(startDate: Date, endDate: Date) {
    // Fetch historical SOL/USD prices
    // Fill sol_usd_prices table
    // Update historical transactions/candles
  }
}
```

#### C. Enhanced Price Operations

```typescript
// Extend src/database/price-operations.ts
interface PriceCandleWithUSD extends PriceCandle {
  open_usd: number;
  high_usd: number;
  low_usd: number;
  close_usd: number;
  volume_usd: number;
}

class EnhancedPriceOperations extends PriceOperations {
  async getLatestPriceWithUSD(tokenId: string): Promise<{
    price_sol: number;
    price_usd: number;
    volume_sol_1h: number;
    volume_usd_1h: number;
  }>;

  async getPriceCandesWithUSD(
    tokenId: string,
    startTime: Date,
    endTime: Date
  ): Promise<PriceCandleWithUSD[]>;
}
```

### 4. Data Flow

```
1. Real-time Flow:
   Pyth/API → SolPriceService → sol_usd_prices table
                              ↓
   Transaction occurs → Calculate USD values → Store with transaction
                              ↓
   Continuous Aggregate → Update candles with USD values

2. Historical Backfill:
   Historical API → Batch insert → sol_usd_prices
                                ↓
   Update transactions/candles → Recalculate USD values
```

### 5. Implementation Steps

#### Phase 1: Core Infrastructure (2-3 days)
1. Create sol_usd_prices table and indexes
2. Implement SolPriceService interface
3. Build Pyth Network integration
4. Create price update worker
5. Test real-time price updates

#### Phase 2: Database Integration (2-3 days)
1. Add USD columns to existing tables
2. Create triggers/functions for automatic USD calculation
3. Update continuous aggregates
4. Implement EnhancedPriceOperations
5. Test USD price calculations

#### Phase 3: Historical Data (1-2 days)
1. Implement historical price fetcher
2. Backfill sol_usd_prices for existing data
3. Update all historical transactions with USD values
4. Verify data accuracy

#### Phase 4: Monitor Integration (1-2 days)
1. Update monitors to calculate USD values in real-time
2. Modify transaction saving to include USD prices
3. Update display formatters
4. Test end-to-end flow

### 6. Considerations

#### Performance Impact
- Additional calculations per transaction (minimal)
- Extra storage: ~8-16 bytes per transaction
- Continuous aggregate refresh time may increase slightly
- Consider indexing strategy for USD columns

#### Accuracy Concerns
1. **Price Synchronization**
   - SOL price at exact transaction time
   - Interpolation for missing data points
   - Handle price feed outages

2. **Multiple Price Sources**
   - Average multiple sources for reliability
   - Detect and handle outliers
   - Fallback mechanisms

#### Edge Cases
1. **Missing Historical Data**
   - Use nearest available price
   - Mark estimates vs actual prices
   - Provide confidence scores

2. **Extreme Volatility**
   - Cache prices for short periods
   - Implement sanity checks
   - Alert on unusual price movements

### 7. SQL Functions for USD Calculations

```sql
-- Function to get SOL/USD price at specific time
CREATE OR REPLACE FUNCTION get_sol_usd_price(p_timestamp TIMESTAMPTZ)
RETURNS NUMERIC AS $$
DECLARE
    v_price NUMERIC;
BEGIN
    -- Try exact match first
    SELECT price_usd INTO v_price
    FROM sol_usd_prices
    WHERE price_time <= p_timestamp
    ORDER BY price_time DESC
    LIMIT 1;
    
    -- If no price found, use interpolation
    IF v_price IS NULL THEN
        WITH prices AS (
            SELECT 
                price_usd,
                price_time,
                LEAD(price_usd) OVER (ORDER BY price_time) as next_price,
                LEAD(price_time) OVER (ORDER BY price_time) as next_time
            FROM sol_usd_prices
            WHERE price_time <= p_timestamp + INTERVAL '1 hour'
                AND price_time >= p_timestamp - INTERVAL '1 hour'
        )
        SELECT 
            price_usd + (next_price - price_usd) * 
            EXTRACT(EPOCH FROM (p_timestamp - price_time)) / 
            EXTRACT(EPOCH FROM (next_time - price_time))
        INTO v_price
        FROM prices
        WHERE price_time <= p_timestamp 
            AND next_time > p_timestamp
        LIMIT 1;
    END IF;
    
    RETURN COALESCE(v_price, 0);
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically calculate USD values
CREATE OR REPLACE FUNCTION calculate_usd_values()
RETURNS TRIGGER AS $$
DECLARE
    v_sol_price NUMERIC;
BEGIN
    -- Get SOL price at transaction time
    v_sol_price := get_sol_usd_price(NEW.block_time);
    
    -- Calculate USD values
    NEW.price_per_token_usd := NEW.price_per_token * v_sol_price;
    NEW.sol_amount_usd := NEW.sol_amount * v_sol_price;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_calculate_usd_values
BEFORE INSERT ON transactions
FOR EACH ROW
EXECUTE FUNCTION calculate_usd_values();
```

### 8. Monitoring and Maintenance

#### Health Checks
1. Price feed availability
2. Data freshness (last update time)
3. Price deviation alerts
4. Missing data gap detection

#### Maintenance Tasks
1. Daily: Verify price feed accuracy
2. Weekly: Check for data gaps
3. Monthly: Optimize indexes and aggregates
4. Quarterly: Review data retention policies

### 9. Testing Strategy

#### Unit Tests
- Price service mock implementations
- USD calculation accuracy
- Edge case handling

#### Integration Tests
- End-to-end price flow
- Historical backfill accuracy
- Performance benchmarks

#### Validation
- Compare USD values with external sources
- Verify calculation consistency
- Test during high volatility periods

### 10. Future Enhancements

1. **Multi-currency Support**
   - EUR, GBP, JPY prices
   - User-preferred currency settings
   - Automatic conversion

2. **Advanced Analytics**
   - USD-based PnL tracking
   - Portfolio valuation
   - Tax reporting features

3. **Price Alerts**
   - USD price thresholds
   - Significant SOL/USD movements
   - Arbitrage opportunities

## Conclusion

This implementation plan provides a robust foundation for USD price tracking while maintaining system performance and data accuracy. The phased approach allows for incremental deployment and testing, minimizing risk to the existing system.