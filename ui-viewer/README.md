# Megatron V2 - Database Viewer

A simple, static HTML viewer for Megatron V2 token database. Works like a database viewer extension without any complex API/WebSocket systems.

## Features

- **Static HTML Interface** - No server needed, just open index.html
- **JSON Data Export** - Database data exported to JSON files
- **Auto-refresh** - UI refreshes data every 30 seconds
- **Multiple Views**:
  - Tokens - View all tracked tokens
  - Pools - View liquidity pools
  - Transactions - View recent buy/sell transactions
  - Summary - Overview statistics

## Usage

1. **Export Data from Database**:
   ```bash
   # From ui-viewer directory
   ./export.bat
   
   # Or manually from project root
   npm run ui:export
   ```

2. **Open Viewer**:
   
   **Option A - Using local server (recommended)**:
   ```bash
   # From ui-viewer directory
   ./serve.bat
   # Then open http://localhost:8080 in your browser
   ```
   
   **Option B - Direct file access**:
   - Open `ui-viewer/index.html` in your browser
   - Note: Some browsers block local file access. If you see "No tokens found", use Option A

3. **Auto-refresh**:
   - The viewer auto-refreshes every 30 seconds
   - Click "Refresh Data" button for manual refresh

## Features

- **Filtering**: Search tokens, pools, and transactions
- **Copy to Clipboard**: Click addresses to copy
- **Platform Filtering**: Filter by Pump.fun or Raydium
- **Transaction Type Filtering**: Filter by buy/sell
- **Responsive Design**: Works on desktop and mobile

## Data Export

The export script queries the last:
- 1,000 tokens
- 1,000 pools  
- 5,000 transactions (last 7 days)

## Adding to Package.json

Add these scripts to your main package.json:
```json
"ui:export": "tsx ui-viewer/scripts/export-data.ts",
"ui:open": "start ui-viewer/index.html"
```

## Architecture

```
/ui-viewer/
  /data/              # JSON exports (git-ignored)
    tokens.json       # Token data
    pools.json        # Pool data
    transactions.json # Transaction data
    stats.json        # Summary statistics
  /scripts/
    export-data.ts    # Database export script
  index.html          # Main viewer
  viewer.js           # UI logic (vanilla JS)
  styles.css          # Styling
  export.bat          # Windows batch script
```

## Benefits

- Zero interference with monitors/testing
- No running processes
- Works offline
- Easy to debug (just JSON files)
- No dependencies in runtime
- Fast and lightweight