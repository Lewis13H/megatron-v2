/**
 * Progressive Bonding Curve Scoring
 * Implements a bell curve that starts at 0 for new tokens and peaks at 50-55%
 * This prevents early FOMO and rewards patience
 */

export interface ProgressiveScoreResult {
  totalScore: number;
  positionScore: number;
  velocityScore: number;
  consistencyScore: number;
  phase: string;
  multiplier: number;
  recommendation: string;
}

export class ProgressiveBondingCurveScorer {
  
  /**
   * Calculate progressive bonding curve score
   * Starts near 0 for new tokens, peaks at 50-55%, then declines
   */
  calculate(
    progress: number,
    velocityPerHour: number = 1.0,
    consistency: number = 0.5
  ): ProgressiveScoreResult {
    
    // Calculate base scores
    let positionScore = this.calculateProgressivePositionScore(progress);
    let velocityScore = this.calculateVelocityScore(velocityPerHour);
    const consistencyScore = consistency * 12.5;
    
    // Apply "proof of life" multiplier for very early tokens
    const multiplier = this.getProofMultiplier(progress);
    positionScore *= multiplier;
    
    // Also reduce velocity score for unproven tokens
    if (progress < 10) {
      velocityScore *= 0.5;
    } else if (progress < 20) {
      velocityScore *= 0.75;
    }
    
    const totalScore = positionScore + velocityScore + consistencyScore;
    const phase = this.getPhase(progress);
    const recommendation = this.getRecommendation(progress, totalScore);
    
    return {
      totalScore,
      positionScore,
      velocityScore,
      consistencyScore,
      phase,
      multiplier,
      recommendation
    };
  }
  
  /**
   * Progressive position scoring following the bell curve
   * 0% → 0 points, peaks at 50-55% → 37.5 points
   */
  private calculateProgressivePositionScore(progress: number): number {
    if (progress < 5) {
      // Near launch: Start at 0, tiny increase
      return progress * 0.5; // 0 to 2.5 points
      
    } else if (progress < 15) {
      // Early stage: Slow linear growth
      return 2.5 + (progress - 5) * 0.75; // 2.5 to 10 points
      
    } else if (progress < 35) {
      // Building momentum: Moderate growth
      return 10 + (progress - 15) * 0.625; // 10 to 22.5 points
      
    } else if (progress < 45) {
      // Approaching optimal: Steep climb
      return 22.5 + (progress - 35) * 1.25; // 22.5 to 35 points
      
    } else if (progress <= 55) {
      // OPTIMAL ZONE: Maximum points
      return 37.5; // Peak score
      
    } else if (progress <= 65) {
      // Post-peak: Gradual decline
      return 37.5 - (progress - 55) * 1.0; // 37.5 to 27.5 points
      
    } else if (progress <= 75) {
      // Late stage: Steeper decline  
      return 27.5 - (progress - 65) * 1.5; // 27.5 to 12.5 points
      
    } else if (progress <= 85) {
      // Near graduation: Flatten near bottom
      return 12.5 - (progress - 75) * 0.75; // 12.5 to 5 points
      
    } else {
      // Too late: Minimal score
      return 3; // Floor value
    }
  }
  
  /**
   * Velocity scoring (0-33 points)
   */
  private calculateVelocityScore(velocityPerHour: number): number {
    if (velocityPerHour >= 0.5 && velocityPerHour <= 2.0) {
      return 33; // Perfect velocity
    } else if (velocityPerHour >= 0.3 && velocityPerHour < 0.5) {
      return 25; // Slightly slow
    } else if (velocityPerHour > 2.0 && velocityPerHour <= 3.0) {
      return 20; // Fast but manageable
    } else if (velocityPerHour > 3.0 && velocityPerHour <= 5.0) {
      return 10; // Too fast, FOMO risk
    } else if (velocityPerHour > 0 && velocityPerHour < 0.3) {
      return 8; // Too slow
    } else {
      return 0; // No movement
    }
  }
  
  /**
   * "Proof of life" multiplier - tokens must prove themselves
   */
  private getProofMultiplier(progress: number): number {
    if (progress < 10) {
      return 0.3; // Heavy penalty for unproven tokens
    } else if (progress < 20) {
      return 0.6; // Still proving itself
    } else if (progress < 30) {
      return 0.85; // Getting established
    } else {
      return 1.0; // Fully proven
    }
  }
  
  /**
   * Get current phase description
   */
  private getPhase(progress: number): string {
    if (progress < 5) return '🔴 Launch Phase';
    if (progress < 35) return '🟡 Proving Phase';
    if (progress < 45) return '🟠 Momentum Building';
    if (progress <= 55) return '🟢 OPTIMAL ENTRY';
    if (progress <= 75) return '🟡 Late Stage';
    return '🔴 Graduation Risk';
  }
  
  /**
   * Get trading recommendation based on score and progress
   */
  private getRecommendation(progress: number, score: number): string {
    if (progress < 5) {
      return "⛔ TOO EARLY: Token just launched. Wait for proof of momentum.";
    }
    
    if (progress < 20) {
      return "⚠️ EARLY STAGE: Token still proving itself. Consider small position only if other metrics strong.";
    }
    
    if (progress < 35) {
      return "📊 MONITORING: Token showing promise. Watch for acceleration toward optimal zone.";
    }
    
    if (progress < 45) {
      return "🔔 APPROACHING OPTIMAL: Prepare for entry. Monitor closely for 45% threshold.";
    }
    
    if (progress <= 55) {
      if (score >= 70) {
        return "✅ OPTIMAL ENTRY: Perfect conditions. Execute full position per thesis.";
      }
      return "✅ OPTIMAL ZONE: Good entry point. Size position based on total score.";
    }
    
    if (progress <= 65) {
      return "⏰ LATE ENTRY: Past optimal but may still profit. Reduce position size.";
    }
    
    if (progress <= 75) {
      return "⚠️ HIGH RISK: Approaching graduation. Only enter with strong momentum signals.";
    }
    
    return "🚫 TOO LATE: Graduation imminent. Avoid entry.";
  }
  
  /**
   * Generate visual representation of the scoring curve
   */
  generateCurveData(): Array<{progress: number, score: number, phase: string}> {
    const data = [];
    
    for (let progress = 0; progress <= 100; progress += 2) {
      const result = this.calculate(progress, 1.0, 0.5);
      data.push({
        progress,
        score: result.totalScore,
        phase: result.phase
      });
    }
    
    return data;
  }
  
  /**
   * Check if token is in optimal entry zone
   */
  isOptimalEntry(progress: number, marketCapUsd: number): boolean {
    return (progress >= 45 && progress <= 55) && 
           (marketCapUsd >= 15000 && marketCapUsd <= 25000);
  }
  
  /**
   * Calculate position size multiplier based on progressive scoring
   */
  getPositionSizeMultiplier(progress: number, totalScore: number): number {
    // No position for unproven tokens
    if (progress < 20 || totalScore < 30) {
      return 0;
    }
    
    // Optimal zone gets full position
    if (progress >= 45 && progress <= 55 && totalScore >= 70) {
      return 1.0;
    }
    
    // Scale based on score
    if (totalScore >= 75) return 0.9;
    if (totalScore >= 65) return 0.7;
    if (totalScore >= 55) return 0.5;
    if (totalScore >= 45) return 0.3;
    if (totalScore >= 35) return 0.2;
    
    return 0.1; // Minimum position
  }
}

// Export singleton
export const progressiveBondingCurveScorer = new ProgressiveBondingCurveScorer();