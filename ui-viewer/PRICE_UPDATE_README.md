# UI Viewer Price Update

## What Was Updated

The UI viewer has been updated to display the authoritative price from the Pump.fun token price monitor.

### Changes Made:

1. **Database Schema**
   - Added `latest_price` column to the `pools` table to store the formatted price in SOL
   - Created migration: `006_add_latest_price_to_pools.sql`

2. **Price Monitor**
   - Updated `pumpfun-monitor-token-price.ts` to save the `formattedPrice` to the database
   - The price is calculated exactly as in the Shyft example and stored as the authoritative price

3. **Data Export**
   - Updated `export-data.ts` to include `latestPrice` and `updatedAt` fields
   - Pools are now ordered by `updated_at` to show the most recently updated first

4. **UI Viewer**
   - Updated token display to use `pool.latestPrice` when available
   - Falls back to calculating from reserves if `latestPrice` is not available
   - Added price column to the pools table view
   - Shows "Last Updated" timestamp for pools

## How Prices Are Displayed

1. **Tokens Tab**: Shows price per token in SOL
   - Uses `latestPrice` from database (authoritative)
   - Falls back to calculated price if not available

2. **Pools Tab**: Shows current token price
   - Displays the `latestPrice` field
   - Shows "N/A" if no price available

## Price Format

Prices are formatted based on their magnitude:
- Very small prices (< 0.000001): Scientific notation (e.g., 5.8967e-8)
- Small prices (< 0.01): 9 decimal places (e.g., 0.000000059)
- Regular prices: 6 decimal places (e.g., 0.000059)

## Running the UI

1. Export latest data:
   ```bash
   npm run ui:export
   ```

2. Open the viewer:
   ```bash
   npm run ui:open
   ```

## Verifying Prices

The prices shown in the UI should match:
- The `formattedPrice` output from the price monitor
- The `latest_price` stored in the database
- The price shown on pump.fun website