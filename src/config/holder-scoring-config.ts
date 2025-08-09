import * as fs from 'fs';
import * as path from 'path';

export interface ScoringThresholds {
  excellent: number;
  good: number;
  fair: number;
  poor: number;
  points: {
    excellent: number;
    good: number;
    fair: number;
    poor: number;
    terrible: number;
  };
}

export interface WalletAgeThresholds {
  excellent: number;
  good: number;
  fair: number;
  acceptable: number;
  poor: number;
  points: {
    excellent: number;
    good: number;
    fair: number;
    acceptable: number;
    poor: number;
    terrible: number;
  };
}

export interface HolderScoringConfig {
  distribution: {
    gini: ScoringThresholds;
    top1Percent: ScoringThresholds;
    holderCount: {
      divisor: number;
      maxPoints: number;
    };
  };
  quality: {
    botRatio: ScoringThresholds;
    smartMoney: {
      multiplier: number;
      maxPoints: number;
    };
    walletAge: WalletAgeThresholds;
  };
  activity: {
    activeHolders: {
      multiplier: number;
      maxPoints: number;
    };
    organicGrowth: {
      multiplier: number;
      maxPoints: number;
    };
    velocity: {
      multiplier: number;
      maxPoints: number;
    };
  };
  alerts: {
    critical: {
      giniThreshold: number;
      botRatioThreshold: number;
      riskScoreThreshold: number;
    };
    warning: {
      topHolderThreshold: number;
      walletAgeThreshold: number;
    };
    positive: {
      smartMoneyThreshold: number;
      totalScoreThreshold: number;
    };
  };
  quickScore: {
    uniqueBuyers: {
      high: number;
      medium: number;
      low: number;
      points: {
        high: number;
        medium: number;
        low: number;
      };
    };
    largestBuy: {
      high: number;
      medium: number;
      low: number;
      points: {
        high: number;
        medium: number;
        low: number;
      };
    };
    buyRatio: {
      high: number;
      medium: number;
      low: number;
      points: {
        high: number;
        medium: number;
        low: number;
      };
    };
  };
}

export class ScoringConfigLoader {
  private static instance: ScoringConfigLoader;
  private config!: HolderScoringConfig;
  private configPath: string;
  private lastModified!: Date;

  private constructor() {
    this.configPath = path.join(__dirname, 'holder-scoring-config.json');
    this.loadConfig();
  }

  static getInstance(): ScoringConfigLoader {
    if (!ScoringConfigLoader.instance) {
      ScoringConfigLoader.instance = new ScoringConfigLoader();
    }
    return ScoringConfigLoader.instance;
  }

  private loadConfig(): void {
    try {
      const configData = fs.readFileSync(this.configPath, 'utf-8');
      this.config = JSON.parse(configData);
      const stats = fs.statSync(this.configPath);
      this.lastModified = stats.mtime;
      console.log('✅ Loaded holder scoring configuration');
    } catch (error) {
      console.error('Error loading scoring config:', error);
      // Fall back to hardcoded defaults if config file fails
      this.config = this.getDefaultConfig();
    }
  }

  // Hot reload config if file has changed
  public getConfig(): HolderScoringConfig {
    try {
      const stats = fs.statSync(this.configPath);
      if (stats.mtime > this.lastModified) {
        console.log('🔄 Reloading updated scoring configuration');
        this.loadConfig();
      }
    } catch (error) {
      // Ignore stat errors, use cached config
    }
    return this.config;
  }

  // Override specific values for testing or environment-specific settings
  public override(overrides: Partial<HolderScoringConfig>): void {
    this.config = this.deepMerge(this.config, overrides);
  }

  private deepMerge(target: any, source: any): any {
    const output = { ...target };
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        output[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }

  private getDefaultConfig(): HolderScoringConfig {
    // Fallback configuration matching current hardcoded values
    return {
      distribution: {
        gini: {
          excellent: 0.3,
          good: 0.5,
          fair: 0.7,
          poor: 0.8,
          points: { excellent: 40, good: 30, fair: 20, poor: 10, terrible: 0 }
        },
        top1Percent: {
          excellent: 5,
          good: 10,
          fair: 15,
          poor: 20,
          points: { excellent: 40, good: 30, fair: 20, poor: 10, terrible: 0 }
        },
        holderCount: { divisor: 10, maxPoints: 31 }
      },
      quality: {
        botRatio: {
          excellent: 0.1,
          good: 0.2,
          fair: 0.3,
          poor: 0.4,
          points: { excellent: 40, good: 30, fair: 20, poor: 10, terrible: 0 }
        },
        smartMoney: { multiplier: 400, maxPoints: 40 },
        walletAge: {
          excellent: 90,
          good: 60,
          fair: 30,
          acceptable: 14,
          poor: 7,
          points: { excellent: 31, good: 25, fair: 20, acceptable: 15, poor: 10, terrible: 5 }
        }
      },
      activity: {
        activeHolders: { multiplier: 50, maxPoints: 40 },
        organicGrowth: { multiplier: 40, maxPoints: 40 },
        velocity: { multiplier: 31, maxPoints: 31 }
      },
      alerts: {
        critical: { giniThreshold: 0.9, botRatioThreshold: 0.5, riskScoreThreshold: 80 },
        warning: { topHolderThreshold: 20, walletAgeThreshold: 7 },
        positive: { smartMoneyThreshold: 0.1, totalScoreThreshold: 250 }
      },
      quickScore: {
        uniqueBuyers: {
          high: 10, medium: 5, low: 2,
          points: { high: 15, medium: 10, low: 5 }
        },
        largestBuy: {
          high: 2, medium: 1, low: 0.5,
          points: { high: 15, medium: 10, low: 5 }
        },
        buyRatio: {
          high: 2, medium: 1.5, low: 1,
          points: { high: 20, medium: 15, low: 10 }
        }
      }
    };
  }
}

// Environment-specific overrides
export function getEnvironmentOverrides(): Partial<HolderScoringConfig> {
  const env = process.env.NODE_ENV || 'development';
  
  if (env === 'production') {
    // More conservative thresholds in production
    return {
      alerts: {
        critical: {
          giniThreshold: 0.85,
          botRatioThreshold: 0.4,
          riskScoreThreshold: 75
        },
        warning: {
          topHolderThreshold: 25,
          walletAgeThreshold: 5
        },
        positive: {
          smartMoneyThreshold: 0.15,
          totalScoreThreshold: 270
        }
      }
    };
  }
  
  return {};
}