import { getDbPool } from '../../database/connection';

interface CreditUsage {
  endpoint: string;
  credits: number;
  timestamp: Date;
}

interface UsageStats {
  daily: number;
  weekly: number;
  monthly: number;
  projectedMonthly: number;
  percentageUsed: number;
  remainingCredits: number;
  willExceedLimit: boolean;
  recommendedDailyLimit: number;
}

export class CreditTracker {
  private static instance: CreditTracker | null = null;
  private static initPromise: Promise<void> | null = null;
  private monthlyLimit: number;
  private currentMonthUsage: number = 0;
  private dailyUsage = new Map<string, number>();
  private usageHistory: CreditUsage[] = [];
  private dbPool: any;
  private lastReset: Date;
  private initialized: boolean = false;
  
  // Optimized targets: Use 50-75% of monthly credits (5-7.5M)
  private readonly TARGET_USAGE_MIN = 0.50;
  private readonly TARGET_USAGE_MAX = 0.75;
  private readonly SAFETY_BUFFER = 0.85; // Stop at 85% to leave buffer
  
  private constructor(monthlyLimit: number = 10_000_000) {
    this.monthlyLimit = monthlyLimit;
    this.dbPool = getDbPool();
    this.lastReset = new Date();
  }
  
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    
    await this.loadUsageFromDB();
    this.scheduleMonthlyReset();
    this.initialized = true;
  }
  
  static getInstance(monthlyLimit: number = 10_000_000): CreditTracker {
    if (!CreditTracker.instance) {
      CreditTracker.instance = new CreditTracker(monthlyLimit);
    }
    return CreditTracker.instance;
  }
  
  static resetInstance(): void {
    CreditTracker.instance = null;
  }

  async increment(credits: number, endpoint: string = 'general'): Promise<void> {
    // Save to database first
    await this.saveUsage(endpoint, credits);
    
    // Then update local state
    this.currentMonthUsage += credits;
    
    const today = new Date().toISOString().split('T')[0];
    this.dailyUsage.set(today, (this.dailyUsage.get(today) || 0) + credits);
    
    // Add to history
    this.usageHistory.push({
      endpoint,
      credits,
      timestamp: new Date()
    });
    
    // Keep only last 30 days of history
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    this.usageHistory = this.usageHistory.filter(u => u.timestamp > thirtyDaysAgo);
    
    // Check thresholds and warn
    this.checkUsageThresholds();
  }
  
  private async saveUsage(endpoint: string, credits: number): Promise<void> {
    try {
      // Update or insert daily usage record
      await this.dbPool.query(`
        INSERT INTO helius_api_usage (date, endpoint, credits_used)
        VALUES (CURRENT_DATE, $1, $2)
        ON CONFLICT (date, endpoint) 
        DO UPDATE SET credits_used = helius_api_usage.credits_used + $2
      `, [endpoint, credits]);
    } catch (error) {
      console.error('Error saving API usage:', error);
    }
  }
  
  private async loadUsageFromDB(): Promise<void> {
    try {
      // Load current month's usage
      const result = await this.dbPool.query(`
        SELECT SUM(credits_used) as total
        FROM helius_api_usage
        WHERE date >= DATE_TRUNC('month', CURRENT_DATE)
      `);
      
      this.currentMonthUsage = result.rows[0]?.total || 0;
      
      // Load daily usage for the last 30 days
      const dailyResult = await this.dbPool.query(`
        SELECT date, SUM(credits_used) as daily_total
        FROM helius_api_usage
        WHERE date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY date
        ORDER BY date DESC
      `);
      
      dailyResult.rows.forEach((row: any) => {
        const date = row.date.toISOString().split('T')[0];
        this.dailyUsage.set(date, row.daily_total);
      });
      
    } catch (error) {
      console.error('Error loading API usage:', error);
    }
  }
  
  private checkUsageThresholds(): void {
    const percentage = (this.currentMonthUsage / this.monthlyLimit) * 100;
    
    if (percentage >= 85) {
      console.error(`🚨 CRITICAL: API usage at ${percentage.toFixed(1)}% - STOPPING SOON`);
    } else if (percentage >= 75) {
      console.warn(`⚠️ WARNING: API usage at ${percentage.toFixed(1)}% of monthly limit`);
    } else if (percentage >= 50) {
      console.log(`📊 API usage at ${percentage.toFixed(1)}% - On target`);
    }
  }
  
  getProjectedMonthlyUsage(): number {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysPassed = now.getDate();
    
    if (daysPassed === 0) return 0;
    
    const avgDailyUsage = this.currentMonthUsage / daysPassed;
    return avgDailyUsage * daysInMonth;
  }
  
  canMakeRequest(estimatedCredits: number): boolean {
    // Check if we're under safety buffer
    const currentPercentage = this.currentMonthUsage / this.monthlyLimit;
    if (currentPercentage >= this.SAFETY_BUFFER) {
      return false;
    }
    
    // Check if this request would exceed limit
    const afterRequest = this.currentMonthUsage + estimatedCredits;
    return afterRequest < (this.monthlyLimit * this.SAFETY_BUFFER);
  }
  
  getOptimalRequestRate(): number {
    // Calculate optimal requests per minute to use 50-75% of credits
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysRemaining = daysInMonth - now.getDate() + 1;
    
    // Target middle of range (62.5%)
    const targetUsage = this.monthlyLimit * ((this.TARGET_USAGE_MIN + this.TARGET_USAGE_MAX) / 2);
    const remainingTarget = targetUsage - this.currentMonthUsage;
    
    if (remainingTarget <= 0) {
      return 0; // Already at target
    }
    
    // Calculate credits per minute needed
    const minutesRemaining = daysRemaining * 24 * 60;
    const creditsPerMinute = remainingTarget / minutesRemaining;
    
    // Assuming average 100 credits per token analysis
    const tokensPerMinute = creditsPerMinute / 100;
    
    return Math.max(1, Math.floor(tokensPerMinute));
  }
  
  async getStats(): Promise<UsageStats> {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    // Calculate daily average
    const last7Days = Array.from(this.dailyUsage.entries())
      .filter(([date]) => {
        const d = new Date(date);
        const daysDiff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
        return daysDiff <= 7;
      })
      .reduce((sum, [_, credits]) => sum + credits, 0);
    
    const dailyAvg = last7Days / Math.min(7, this.dailyUsage.size);
    
    // Calculate projections
    const projectedMonthly = this.getProjectedMonthlyUsage();
    const percentageUsed = (this.currentMonthUsage / this.monthlyLimit) * 100;
    const remainingCredits = this.monthlyLimit - this.currentMonthUsage;
    
    // Calculate recommended daily limit to reach target
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysRemaining = daysInMonth - now.getDate() + 1;
    const targetCredits = this.monthlyLimit * this.TARGET_USAGE_MAX;
    const creditsToUse = targetCredits - this.currentMonthUsage;
    const recommendedDailyLimit = Math.max(0, creditsToUse / daysRemaining);
    
    return {
      daily: this.dailyUsage.get(today) || 0,
      weekly: last7Days,
      monthly: this.currentMonthUsage,
      projectedMonthly,
      percentageUsed,
      remainingCredits,
      willExceedLimit: projectedMonthly > this.monthlyLimit,
      recommendedDailyLimit
    };
  }
  
  async getDetailedBreakdown(): Promise<any> {
    try {
      // Get breakdown by endpoint
      const result = await this.dbPool.query(`
        SELECT 
          endpoint,
          SUM(credits_used) as total_credits,
          COUNT(*) as request_count,
          AVG(credits_used) as avg_credits_per_request
        FROM helius_api_usage
        WHERE date >= DATE_TRUNC('month', CURRENT_DATE)
        GROUP BY endpoint
        ORDER BY total_credits DESC
      `);
      
      return result.rows;
    } catch (error) {
      console.error('Error getting detailed breakdown:', error);
      return [];
    }
  }
  
  private scheduleMonthlyReset(): void {
    // Calculate milliseconds until next month
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const msUntilReset = nextMonth.getTime() - now.getTime();
    
    // Limit to max 32-bit signed integer (about 24.8 days)
    const MAX_TIMEOUT = 2147483647;
    const safeTimeout = Math.min(msUntilReset, MAX_TIMEOUT);
    
    // If we need to wait longer than the max, schedule intermediate check
    if (msUntilReset > MAX_TIMEOUT) {
      setTimeout(() => {
        this.scheduleMonthlyReset(); // Re-schedule when closer
      }, safeTimeout);
    } else {
      setTimeout(() => {
        this.resetMonthlyUsage();
        this.scheduleMonthlyReset(); // Schedule next reset
      }, safeTimeout);
    }
  }
  
  private resetMonthlyUsage(): void {
    // Only log if actually resetting (not on initialization)
    if (this.currentMonthUsage > 0) {
      console.log('📅 Resetting monthly API usage counter');
    }
    this.currentMonthUsage = 0;
    this.lastReset = new Date();
    
    // Clear old daily usage
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(now.getDate() - 30);
    
    this.dailyUsage = new Map(
      Array.from(this.dailyUsage.entries()).filter(([date]) => {
        return new Date(date) > thirtyDaysAgo;
      })
    );
  }
  
  // Get recommended analysis frequency based on current usage
  getRecommendedFrequency(): { 
    tokensPerHour: number; 
    intervalMs: number; 
    batchSize: number 
  } {
    const stats = {
      daily: this.dailyUsage.get(new Date().toISOString().split('T')[0]) || 0,
      monthly: this.currentMonthUsage,
      projected: this.getProjectedMonthlyUsage()
    };
    
    const targetMonthly = this.monthlyLimit * 0.625; // 62.5% target
    const currentPercentage = this.currentMonthUsage / this.monthlyLimit;
    
    let tokensPerHour: number;
    let batchSize: number;
    
    if (currentPercentage < 0.4) {
      // Under-utilizing, increase rate
      tokensPerHour = 100; // Aggressive
      batchSize = 10;
    } else if (currentPercentage < 0.5) {
      // Slightly under, moderate increase
      tokensPerHour = 60;
      batchSize = 8;
    } else if (currentPercentage < 0.7) {
      // On target
      tokensPerHour = 40;
      batchSize = 5;
    } else if (currentPercentage < 0.8) {
      // Slightly over, reduce
      tokensPerHour = 20;
      batchSize = 3;
    } else {
      // Near limit, minimal usage
      tokensPerHour = 10;
      batchSize = 1;
    }
    
    const intervalMs = Math.floor(3600000 / tokensPerHour); // ms between tokens
    
    return {
      tokensPerHour,
      intervalMs,
      batchSize
    };
  }
  
  // Estimate credits for token analysis
  estimateTokenAnalysisCredits(holderCount: number, cacheHitRate: number = 0.7): number {
    // Base: 1 credit per 1000 holders for getTokenAccounts
    const holderFetchCredits = Math.ceil(holderCount / 1000);
    
    // Wallet enrichment: 2 credits per wallet (with cache consideration)
    const uncachedWallets = Math.floor(holderCount * (1 - cacheHitRate));
    const enrichmentCredits = uncachedWallets * 2;
    
    return holderFetchCredits + enrichmentCredits;
  }
  
  // Format stats for display
  formatStats(stats: UsageStats): string {
    const lines = [
      `📊 Helius API Usage Statistics`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `Today:     ${this.formatNumber(stats.daily)} credits`,
      `This Week: ${this.formatNumber(stats.weekly)} credits`,
      `This Month: ${this.formatNumber(stats.monthly)} credits (${stats.percentageUsed.toFixed(1)}%)`,
      ``,
      `📈 Projections`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `Projected Monthly: ${this.formatNumber(stats.projectedMonthly)} credits`,
      `Remaining Credits: ${this.formatNumber(stats.remainingCredits)}`,
      `Recommended Daily: ${this.formatNumber(stats.recommendedDailyLimit)}`,
      ``,
      `Status: ${this.getStatusEmoji(stats.percentageUsed)} ${this.getStatusMessage(stats.percentageUsed)}`
    ];
    
    if (stats.willExceedLimit) {
      lines.push(`⚠️ WARNING: On track to exceed monthly limit!`);
    }
    
    return lines.join('\n');
  }
  
  private formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(2)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toFixed(0);
  }
  
  private getStatusEmoji(percentage: number): string {
    if (percentage >= 85) return '🚨';
    if (percentage >= 75) return '⚠️';
    if (percentage >= 50) return '✅';
    if (percentage >= 25) return '📊';
    return '🎯';
  }
  
  private getStatusMessage(percentage: number): string {
    if (percentage >= 85) return 'Critical - Approaching limit';
    if (percentage >= 75) return 'Warning - Reduce usage';
    if (percentage >= 50) return 'On target - Optimal usage';
    if (percentage >= 25) return 'Below target - Can increase';
    return 'Low usage - Increase analysis rate';
  }
}