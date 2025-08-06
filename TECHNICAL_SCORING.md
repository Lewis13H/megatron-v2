# Technical Scoring System

## Quick Start

### 1. Run Database Migration
```bash
npm run score:migrate
```

### 2. Start Score Monitor
```bash
npm run score:monitor
```

### 3. Start Dashboard
```bash
npm run dashboard:serve
```
Open: http://localhost:3001

## Scoring Components (0-333 points)

- **Market Cap Score** (0-100): Entry optimization
- **Bonding Curve Score** (0-83): Progress dynamics
- **Trading Health Score** (0-75): Buy/sell balance
- **Sell-off Response Score** (-60 to +75): Market resilience

## Key Features

- Real-time sell-off detection with multi-window analysis (5/15/30/60 min)
- Dynamic scoring range (-60 to +333)
- Persistent sell-off event tracking
- Time-weighted buy/sell ratios

## API Endpoints

- `GET /api/tokens` - Get tokens with scores
- `GET /api/sentiment` - Market sentiment summary
- `GET /health` - Health check