import { pumpfunIntegration, ScoreUpdateEvent } from './enhanced-integration';
import { technicalScoreCalculator } from '../../scoring/technical-score-calculator';

// ANSI color codes for better terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

// Start continuous monitoring
async function startScoringMonitor() {
  console.log(`${colors.bright}${colors.cyan}🎯 Starting Megatron V2 Technical Score Monitor${colors.reset}`);
  console.log(`${colors.dim}Monitoring pump.fun tokens for score changes...${colors.reset}\n`);
  
  // Listen for score changes
  pumpfunIntegration.on('scoreChange', (event: ScoreUpdateEvent) => {
    const scoreDiff = event.newScore - event.oldScore;
    const scoreColor = scoreDiff > 0 ? colors.green : scoreDiff < 0 ? colors.red : colors.yellow;
    const arrow = scoreDiff > 0 ? '↑' : scoreDiff < 0 ? '↓' : '→';
    
    console.log(`\n${colors.bright}📊 SCORE UPDATE${colors.reset}`);
    console.log(`${colors.dim}${new Date().toLocaleTimeString()}${colors.reset}`);
    console.log(`Token ID: ${colors.cyan}${event.tokenId}${colors.reset}`);
    console.log(`Score Change: ${event.oldScore.toFixed(2)} ${arrow} ${scoreColor}${event.newScore.toFixed(2)}${colors.reset} (${scoreDiff > 0 ? '+' : ''}${scoreDiff.toFixed(2)})`);
    
    const breakdown = event.scoreBreakdown;
    
    // Market Cap Info
    console.log(`\n${colors.bright}Market Cap:${colors.reset}`);
    console.log(`  Value: ${colors.yellow}$${breakdown.marketCap.currentValue.toFixed(2)}${colors.reset}`);
    console.log(`  Score: ${breakdown.marketCap.total.toFixed(2)}/100 (Optimal: ${breakdown.marketCap.optimalRange})`);
    
    // Bonding Curve Info
    console.log(`\n${colors.bright}Bonding Curve:${colors.reset}`);
    console.log(`  Progress: ${colors.cyan}${breakdown.bondingCurve.currentProgress.toFixed(2)}%${colors.reset}`);
    console.log(`  Velocity: ${breakdown.bondingCurve.velocityPerHour.toFixed(2)}%/hour`);
    console.log(`  Score: ${breakdown.bondingCurve.total.toFixed(2)}/83`);
    
    // Trading Health
    console.log(`\n${colors.bright}Trading Health:${colors.reset}`);
    console.log(`  Buy/Sell Ratio: ${breakdown.tradingHealth.currentRatio.toFixed(2)}`);
    console.log(`  Volume Trend: ${breakdown.tradingHealth.volumeTrend > 0 ? '+' : ''}${breakdown.tradingHealth.volumeTrend.toFixed(2)}%`);
    console.log(`  Whale Concentration: ${(breakdown.tradingHealth.whaleConcentration * 100).toFixed(1)}%`);
    console.log(`  Score: ${breakdown.tradingHealth.total.toFixed(2)}/75`);
    
    // Sell-off Response
    if (breakdown.selloffResponse.isActive) {
      console.log(`\n${colors.bright}${colors.red}⚠️  SELL-OFF DETECTED${colors.reset}`);
      console.log(`  Price Drop: -${breakdown.selloffResponse.priceDropPercent.toFixed(2)}%`);
      console.log(`  Recovery Strength: ${breakdown.selloffResponse.recoveryStrength.toFixed(2)}x`);
    } else {
      console.log(`\n${colors.bright}Sell-off Response:${colors.reset}`);
      console.log(`  Status: ${colors.green}No sell-off detected${colors.reset}`);
    }
    console.log(`  Score: ${breakdown.selloffResponse.total.toFixed(2)}/75`);
    
    console.log(`\n${colors.dim}${'─'.repeat(60)}${colors.reset}`);
  });
  
  // Start monitoring all active tokens every 30 seconds
  await pumpfunIntegration.startContinuousMonitoring(30000);
  
  // Show top tokens periodically
  setInterval(async () => {
    console.log(`\n${colors.bright}${colors.yellow}🏆 TOP SCORING TOKENS IN OPTIMAL ENTRY RANGE ($15-30k)${colors.reset}`);
    console.log(`${colors.dim}${new Date().toLocaleTimeString()}${colors.reset}\n`);
    
    const optimal = await pumpfunIntegration.getOptimalEntryTokens();
    
    if (optimal.length === 0) {
      console.log(`${colors.dim}No tokens found in optimal entry range${colors.reset}`);
    } else {
      console.log(`${colors.dim}Rank  Symbol    Score   Market Cap      Progress  Buy/Sell${colors.reset}`);
      console.log(`${colors.dim}${'─'.repeat(60)}${colors.reset}`);
      
      optimal.slice(0, 10).forEach((token, i) => {
        const rank = `${i + 1}.`.padEnd(6);
        const symbol = token.symbol.padEnd(10);
        const score = token.total_score.toFixed(1).padEnd(8);
        const mcap = `$${parseFloat(token.market_cap_usd).toFixed(0)}`.padEnd(15);
        const progress = `${parseFloat(token.bonding_curve_progress).toFixed(1)}%`.padEnd(10);
        const ratio = token.buy_sell_ratio ? token.buy_sell_ratio.toFixed(2) : 'N/A';
        
        console.log(`${rank}${colors.cyan}${symbol}${colors.reset}${score}${colors.yellow}${mcap}${colors.reset}${progress}${ratio}`);
      });
    }
    
    // Show sell-off tokens
    const selloffTokens = await pumpfunIntegration.getSelloffTokens();
    if (selloffTokens.length > 0) {
      console.log(`\n${colors.bright}${colors.red}⚠️  TOKENS EXPERIENCING SELL-OFFS${colors.reset}`);
      console.log(`${colors.dim}Symbol    Score   Market Cap      Recovery${colors.reset}`);
      console.log(`${colors.dim}${'─'.repeat(45)}${colors.reset}`);
      
      selloffTokens.slice(0, 5).forEach(token => {
        const symbol = token.symbol.padEnd(10);
        const score = token.total_score.toFixed(1).padEnd(8);
        const mcap = `$${parseFloat(token.market_cap_usd).toFixed(0)}`.padEnd(15);
        const recovery = token.selloff_response_score.toFixed(1);
        
        console.log(`${colors.red}${symbol}${colors.reset}${score}${mcap}${recovery}`);
      });
    }
    
    console.log(`\n${colors.dim}${'─'.repeat(60)}${colors.reset}`);
  }, 60000); // Every minute
  
  // Show initial status
  console.log(`${colors.green}✓ Score monitoring active${colors.reset}`);
  console.log(`${colors.green}✓ Checking for updates every 30 seconds${colors.reset}`);
  console.log(`${colors.green}✓ Top tokens report every 60 seconds${colors.reset}`);
  console.log(`\n${colors.dim}Press Ctrl+C to stop monitoring${colors.reset}\n`);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n${colors.yellow}Shutting down score monitor...${colors.reset}`);
  process.exit(0);
});

// Start the monitor
startScoringMonitor().catch(error => {
  console.error(`${colors.red}Error starting score monitor:${colors.reset}`, error);
  process.exit(1);
});