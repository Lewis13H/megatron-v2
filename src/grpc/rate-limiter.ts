export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number;
  private windowMs: number;
  private lastRefill: number;
  
  constructor(maxTokens: number, windowMs: number) {
    this.tokens = maxTokens;
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;
    this.refillRate = maxTokens / windowMs; // tokens per millisecond
    this.lastRefill = Date.now();
  }
  
  async tryAcquire(count: number = 1): Promise<boolean> {
    this.refill();
    
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    
    return false;
  }
  
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
  
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
  
  getTimeUntilNextToken(): number {
    if (this.tokens >= this.maxTokens) return 0;
    
    // Time needed for one token in milliseconds
    const msPerToken = this.windowMs / this.maxTokens;
    const tokensNeeded = 1 - (this.tokens % 1);
    
    return Math.ceil(tokensNeeded * msPerToken);
  }
  
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}