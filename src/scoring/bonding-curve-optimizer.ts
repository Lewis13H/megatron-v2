/**
 * Bonding Curve Scoring Optimizer
 * Aligns scoring with pump-fun-trading-thesis.md requirements
 * Optimal entry: 40-80% bonding curve progress at $15-25k market cap
 */

export interface BondingCurveScore {
  totalScore: number;        // 0-83 points
  velocityScore: number;     // 0-33 points  
  positionScore: number;     // 0-37.5 points
  consistencyScore: number;  // 0-12.5 points
  isOptimalEntry: boolean;
  recommendation: string;
}

export class BondingCurveOptimizer {
  // Thesis-aligned constants
  private readonly OPTIMAL_PROGRESS_MIN = 40;  // 40% minimum per thesis
  private readonly OPTIMAL_PROGRESS_MAX = 80;  // 80% maximum per thesis
  private readonly SWEET_SPOT_MIN = 40;        // Best entry point
  private readonly SWEET_SPOT_MAX = 60;        // Best accumulation zone
  
  private readonly OPTIMAL_VELOCITY_MIN = 0.5; // % per hour
  private readonly OPTIMAL_VELOCITY_MAX = 2.0; // % per hour
  
  /**
   * Calculate bonding curve score aligned with trading thesis
   * @param progress Current bonding curve progress (0-100)
   * @param velocityPerHour Progress velocity in % per hour
   * @param historicalStability Optional stability metric (0-1)
   */
  calculateScore(
    progress: number, 
    velocityPerHour: number,
    historicalStability: number = 0.5
  ): BondingCurveScore {
    const velocityScore = this.calculateVelocityScore(velocityPerHour);
    const positionScore = this.calculatePositionScore(progress);
    const consistencyScore = this.calculateConsistencyScore(historicalStability);
    
    const totalScore = velocityScore + positionScore + consistencyScore;
    const isOptimalEntry = this.isInOptimalZone(progress);
    const recommendation = this.getRecommendation(progress, velocityPerHour, totalScore);
    
    return {
      totalScore,
      velocityScore,
      positionScore,
      consistencyScore,
      isOptimalEntry,
      recommendation
    };
  }
  
  /**
   * Calculate velocity score (0-33 points)
   * Optimal: 0.5-2% per hour growth
   */
  private calculateVelocityScore(velocityPerHour: number): number {
    if (velocityPerHour >= this.OPTIMAL_VELOCITY_MIN && 
        velocityPerHour <= this.OPTIMAL_VELOCITY_MAX) {
      return 33; // Perfect velocity
    } else if (velocityPerHour >= 0.3 && velocityPerHour < 0.5) {
      return 25; // Slightly slow
    } else if (velocityPerHour > 2.0 && velocityPerHour <= 3.0) {
      return 20; // Fast but manageable
    } else if (velocityPerHour > 3.0 && velocityPerHour <= 5.0) {
      return 10; // Too fast, FOMO risk
    } else if (velocityPerHour > 0 && velocityPerHour < 0.3) {
      return 8;  // Too slow, may stall
    } else {
      return 0;  // No movement or negative
    }
  }
  
  /**
   * Calculate position score (0-37.5 points)
   * ALIGNED WITH THESIS: 40-80% optimal, 40-60% best
   */
  private calculatePositionScore(progress: number): number {
    if (progress >= this.SWEET_SPOT_MIN && progress <= this.SWEET_SPOT_MAX) {
      // 40-60%: OPTIMAL ENTRY AND ACCUMULATION ZONE
      return 37.5;
    } else if (progress > this.SWEET_SPOT_MAX && progress <= this.OPTIMAL_PROGRESS_MAX) {
      // 60-80%: Still good but approaching graduation
      return 32;
    } else if (progress >= 30 && progress < this.OPTIMAL_PROGRESS_MIN) {
      // 30-40%: Close to optimal, consider early entry
      return 25;
    } else if (progress > this.OPTIMAL_PROGRESS_MAX && progress <= 90) {
      // 80-90%: Late entry, graduation risk
      return 15;
    } else if (progress >= 20 && progress < 30) {
      // 20-30%: Too early but showing promise
      return 12;
    } else if (progress > 90) {
      // >90%: Too late, about to graduate
      return 5;
    } else if (progress >= 10 && progress < 20) {
      // 10-20%: Very early, high risk
      return 8;
    } else if (progress >= 5 && progress < 10) {
      // 5-10%: Extremely early
      return 5;
    } else {
      // <5%: Just launched, maximum risk
      return 2;
    }
  }
  
  /**
   * Calculate consistency score based on historical stability
   * @param stability 0-1 value indicating price/progress stability
   */
  private calculateConsistencyScore(stability: number): number {
    // Max 12.5 points for consistency
    return stability * 12.5;
  }
  
  /**
   * Check if token is in optimal entry zone per thesis
   */
  isInOptimalZone(progress: number): boolean {
    return progress >= this.OPTIMAL_PROGRESS_MIN && 
           progress <= this.OPTIMAL_PROGRESS_MAX;
  }
  
  /**
   * Get human-readable recommendation
   */
  private getRecommendation(
    progress: number, 
    velocity: number, 
    score: number
  ): string {
    // Check optimal zone first
    if (progress >= this.SWEET_SPOT_MIN && progress <= this.SWEET_SPOT_MAX) {
      if (velocity >= this.OPTIMAL_VELOCITY_MIN && velocity <= this.OPTIMAL_VELOCITY_MAX) {
        return "🟢 OPTIMAL ENTRY: Perfect progress (40-60%) with ideal velocity. Begin accumulation.";
      }
      return "🟡 GOOD ENTRY: In optimal progress zone but monitor velocity.";
    }
    
    if (progress > this.SWEET_SPOT_MAX && progress <= this.OPTIMAL_PROGRESS_MAX) {
      return "🟡 LATE ACCUMULATION: Still within thesis range (60-80%) but approaching graduation.";
    }
    
    if (progress < this.OPTIMAL_PROGRESS_MIN) {
      if (progress >= 30) {
        return "🟠 EARLY ENTRY: Below 40% threshold. Wait for optimal zone or enter with smaller position.";
      }
      return "🔴 TOO EARLY: High risk, wait for 40%+ progress per thesis.";
    }
    
    if (progress > this.OPTIMAL_PROGRESS_MAX) {
      return "🔴 TOO LATE: Above 80%, graduation imminent. Avoid entry.";
    }
    
    return "⚪ ASSESS: Unusual metrics, manual review recommended.";
  }
  
  /**
   * Calculate position size multiplier based on bonding curve alignment
   * @returns 0-1 multiplier for position sizing
   */
  getPositionSizeMultiplier(progress: number, velocityPerHour: number): number {
    const score = this.calculateScore(progress, velocityPerHour);
    
    // Maximum position in sweet spot with good velocity
    if (progress >= this.SWEET_SPOT_MIN && 
        progress <= this.SWEET_SPOT_MAX &&
        velocityPerHour >= this.OPTIMAL_VELOCITY_MIN &&
        velocityPerHour <= this.OPTIMAL_VELOCITY_MAX) {
      return 1.0; // Full position
    }
    
    // Scale based on score
    if (score.totalScore >= 70) return 0.9;
    if (score.totalScore >= 60) return 0.75;
    if (score.totalScore >= 50) return 0.6;
    if (score.totalScore >= 40) return 0.4;
    if (score.totalScore >= 30) return 0.25;
    
    return 0; // No position
  }
}

// Export singleton instance
export const bondingCurveOptimizer = new BondingCurveOptimizer();