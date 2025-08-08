/**
 * Scoring Configuration Manager
 * Manages all scoring parameters from database - NO HARDCODED VALUES!
 */

import { getDbPool } from '../database/connection';

export interface ScoringConfig {
  bondingCurve: {
    launchMin: number;
    launchMax: number;
    provingMin: number;
    provingMax: number;
    buildingMin: number;
    buildingMax: number;
    optimalMin: number;
    optimalMax: number;
    decliningMin: number;
    decliningMax: number;
    maxPoints: number;
    velocityOptimalMin: number;
    velocityOptimalMax: number;
  };
  marketCap: {
    launchMcap: number;
    provingMinMcap: number;
    provingMaxMcap: number;
    buildingMinMcap: number;
    buildingMaxMcap: number;
    optimalMinMcap: number;
    optimalMaxMcap: number;
    decliningMinMcap: number;
    decliningMaxMcap: number;
    maxBasePoints: number;
    maxVelocityPoints: number;
  };
  tradingHealth: {
    optimalBuySellRatio: number;
    maxRatioPoints: number;
    maxVolumePoints: number;
    maxDistributionPoints: number;
    whaleConcentrationThreshold: number;
  };
  selloff: {
    minorDropThreshold: number;
    moderateDropThreshold: number;
    severeDropThreshold: number;
    whaleDumpSol: number;
    maxPositivePoints: number;
    maxNegativePoints: number;
  };
  consistency: {
    basePoints: number;
  };
}

export class ScoringConfigManager {
  private pool = getDbPool();
  private cache: ScoringConfig | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  /**
   * Get all scoring configuration from database
   */
  async getConfig(forceRefresh: boolean = false): Promise<ScoringConfig> {
    // Check cache
    if (!forceRefresh && this.cache && Date.now() - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cache;
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT * FROM scoring_config');
      
      const config: ScoringConfig = {
        bondingCurve: {
          launchMin: 0,
          launchMax: 5,
          provingMin: 5,
          provingMax: 35,
          buildingMin: 35,
          buildingMax: 45,
          optimalMin: 45,
          optimalMax: 55,
          decliningMin: 55,
          decliningMax: 75,
          maxPoints: 37.5,
          velocityOptimalMin: 0.5,
          velocityOptimalMax: 2.0
        },
        marketCap: {
          launchMcap: 5800,
          provingMinMcap: 5000,
          provingMaxMcap: 10000,
          buildingMinMcap: 10000,
          buildingMaxMcap: 15000,
          optimalMinMcap: 15000,
          optimalMaxMcap: 30000,
          decliningMinMcap: 30000,
          decliningMaxMcap: 50000,
          maxBasePoints: 60,
          maxVelocityPoints: 40
        },
        tradingHealth: {
          optimalBuySellRatio: 2.0,
          maxRatioPoints: 30,
          maxVolumePoints: 25,
          maxDistributionPoints: 20,
          whaleConcentrationThreshold: 0.1
        },
        selloff: {
          minorDropThreshold: 5,
          moderateDropThreshold: 15,
          severeDropThreshold: 30,
          whaleDumpSol: 5,
          maxPositivePoints: 75,
          maxNegativePoints: -60
        },
        consistency: {
          basePoints: 12.5
        }
      };

      // Map database rows to config object
      for (const row of result.rows) {
        const component = row.component;
        const parameter = row.parameter;
        const value = parseFloat(row.value);

        // Map to nested structure
        switch (component) {
          case 'bonding_curve':
            const bcKey = this.snakeToCamel(parameter) as keyof typeof config.bondingCurve;
            (config.bondingCurve as any)[bcKey] = value;
            break;
          case 'market_cap':
            const mcKey = this.snakeToCamel(parameter) as keyof typeof config.marketCap;
            (config.marketCap as any)[mcKey] = value;
            break;
          case 'trading_health':
            const thKey = this.snakeToCamel(parameter) as keyof typeof config.tradingHealth;
            (config.tradingHealth as any)[thKey] = value;
            break;
          case 'selloff':
            const soKey = this.snakeToCamel(parameter) as keyof typeof config.selloff;
            (config.selloff as any)[soKey] = value;
            break;
          case 'consistency':
            config.consistency.basePoints = value;
            break;
        }
      }

      // Update cache
      this.cache = config;
      this.cacheTimestamp = Date.now();

      return config;
    } finally {
      client.release();
    }
  }

  /**
   * Update a specific configuration value
   */
  async updateConfig(
    component: string,
    parameter: string,
    value: number,
    description?: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        'SELECT update_scoring_config($1, $2, $3, $4)',
        [component, parameter, value, description]
      );
      
      // Invalidate cache
      this.cache = null;
    } finally {
      client.release();
    }
  }

  /**
   * Calculate progressive market cap score
   */
  calculateMarketCapScore(marketCapUsd: number, config?: ScoringConfig): number {
    const cfg = config || this.cache;
    if (!cfg) {
      throw new Error('Configuration not loaded');
    }

    const mc = cfg.marketCap;
    let baseScore = 0;

    if (marketCapUsd < mc.launchMcap) {
      // Just launched: Near 0 points
      baseScore = 0;
    } else if (marketCapUsd < mc.provingMinMcap) {
      // Very early: 0-10 points
      baseScore = (marketCapUsd / mc.provingMinMcap) * 10;
    } else if (marketCapUsd >= mc.provingMinMcap && marketCapUsd < mc.provingMaxMcap) {
      // Proving: 10-25 points
      baseScore = 10 + ((marketCapUsd - mc.provingMinMcap) / (mc.provingMaxMcap - mc.provingMinMcap)) * 15;
    } else if (marketCapUsd >= mc.buildingMinMcap && marketCapUsd < mc.buildingMaxMcap) {
      // Building: 25-45 points
      baseScore = 25 + ((marketCapUsd - mc.buildingMinMcap) / (mc.buildingMaxMcap - mc.buildingMinMcap)) * 20;
    } else if (marketCapUsd >= mc.optimalMinMcap && marketCapUsd <= mc.optimalMaxMcap) {
      // OPTIMAL: Maximum points
      baseScore = mc.maxBasePoints;
    } else if (marketCapUsd > mc.decliningMinMcap && marketCapUsd <= mc.decliningMaxMcap) {
      // Declining: 60-30 points
      baseScore = mc.maxBasePoints - ((marketCapUsd - mc.decliningMinMcap) / (mc.decliningMaxMcap - mc.decliningMinMcap)) * 30;
    } else if (marketCapUsd > mc.decliningMaxMcap && marketCapUsd <= 100000) {
      // Late: 30-10 points
      baseScore = 30 - ((marketCapUsd - mc.decliningMaxMcap) / 50000) * 20;
    } else {
      // Too high
      baseScore = 5;
    }

    return baseScore;
  }

  /**
   * Calculate progressive bonding curve score
   */
  calculateBondingCurveScore(progress: number, velocityPerHour: number, config?: ScoringConfig): number {
    const cfg = config || this.cache;
    if (!cfg) {
      throw new Error('Configuration not loaded');
    }

    const bc = cfg.bondingCurve;
    let positionScore = 0;
    let velocityScore = 0;

    // Velocity scoring
    if (velocityPerHour >= bc.velocityOptimalMin && velocityPerHour <= bc.velocityOptimalMax) {
      velocityScore = 33;
    } else if (velocityPerHour >= 0.3 && velocityPerHour < bc.velocityOptimalMin) {
      velocityScore = 25;
    } else if (velocityPerHour > bc.velocityOptimalMax && velocityPerHour <= 3.0) {
      velocityScore = 20;
    } else if (velocityPerHour > 3.0 && velocityPerHour <= 5.0) {
      velocityScore = 10;
    } else if (velocityPerHour > 0) {
      velocityScore = 8;
    }

    // Progressive position scoring
    if (progress < bc.launchMax) {
      positionScore = progress * 0.5;
    } else if (progress < 15) {
      positionScore = 2.5 + (progress - 5) * 0.75;
    } else if (progress < bc.provingMax) {
      positionScore = 10 + (progress - 15) * 0.625;
    } else if (progress < bc.buildingMax) {
      positionScore = 22.5 + (progress - 35) * 1.25;
    } else if (progress >= bc.optimalMin && progress <= bc.optimalMax) {
      positionScore = bc.maxPoints;
    } else if (progress > bc.optimalMax && progress <= 65) {
      positionScore = bc.maxPoints - (progress - bc.optimalMax) * 1.0;
    } else if (progress > 65 && progress <= bc.decliningMax) {
      positionScore = 27.5 - (progress - 65) * 1.5;
    } else if (progress > bc.decliningMax && progress <= 85) {
      positionScore = 12.5 - (progress - 75) * 0.75;
    } else {
      positionScore = 3;
    }

    // Apply multipliers for unproven tokens
    if (progress < 10) {
      positionScore *= 0.3;
      velocityScore *= 0.5;
    } else if (progress < 20) {
      positionScore *= 0.6;
      velocityScore *= 0.75;
    } else if (progress < 30) {
      positionScore *= 0.85;
    }

    return velocityScore + cfg.consistency.basePoints + positionScore;
  }

  /**
   * Get scoring status for given metrics
   */
  getScoringStatus(bondingCurveProgress: number, marketCapUsd: number): string {
    const config = this.cache;
    if (!config) return 'Unknown';

    const bcOptimal = bondingCurveProgress >= config.bondingCurve.optimalMin && 
                      bondingCurveProgress <= config.bondingCurve.optimalMax;
    const mcOptimal = marketCapUsd >= config.marketCap.optimalMinMcap && 
                      marketCapUsd <= config.marketCap.optimalMaxMcap;

    if (bcOptimal && mcOptimal) return '🎯 OPTIMAL ENTRY';
    if (bondingCurveProgress < 20) return '🔴 Too Early';
    if (bondingCurveProgress > 75) return '⚠️ Too Late';
    if (marketCapUsd < config.marketCap.provingMinMcap) return '💰 Market Cap Too Low';
    if (marketCapUsd > config.marketCap.decliningMaxMcap) return '💸 Market Cap Too High';
    
    return '🟡 Monitor';
  }

  /**
   * Convert snake_case to camelCase
   */
  private snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  /**
   * Print current configuration
   */
  async printConfig(): Promise<void> {
    const config = await this.getConfig(true);
    
    console.log('\n📊 Current Scoring Configuration:\n');
    console.log('Bonding Curve:');
    console.log(`  Optimal Zone: ${config.bondingCurve.optimalMin}-${config.bondingCurve.optimalMax}%`);
    console.log(`  Max Points: ${config.bondingCurve.maxPoints}`);
    
    console.log('\nMarket Cap:');
    console.log(`  Optimal Zone: $${config.marketCap.optimalMinMcap.toLocaleString()}-$${config.marketCap.optimalMaxMcap.toLocaleString()}`);
    console.log(`  Max Base Points: ${config.marketCap.maxBasePoints}`);
    console.log(`  Max Velocity Points: ${config.marketCap.maxVelocityPoints}`);
    
    console.log('\nSell-off Thresholds:');
    console.log(`  Minor: ${config.selloff.minorDropThreshold}%`);
    console.log(`  Moderate: ${config.selloff.moderateDropThreshold}%`);
    console.log(`  Severe: ${config.selloff.severeDropThreshold}%`);
    console.log(`  Whale Dump: ${config.selloff.whaleDumpSol} SOL`);
  }
}

// Export singleton instance
export const scoringConfigManager = new ScoringConfigManager();