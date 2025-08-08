export class RateLimiter {
  private requestQueue: (() => Promise<any>)[] = [];
  private processing = false;
  private lastRequestTime = 0;
  private requestCount = 0;
  private windowStart = Date.now();
  
  constructor(
    private maxRequestsPerMinute: number = 300,
    private maxRequestsPerSecond: number = 10
  ) {}
  
  async execute<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    let lastError: any;
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.waitForSlot();
        return await fn();
      } catch (error: any) {
        lastError = error;
        
        // Check for rate limit error
        if (error.response?.status === 429 || error.message?.includes('429')) {
          const backoffTime = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30s
          console.log(`Rate limited. Backing off for ${backoffTime}ms (attempt ${attempt + 1}/${retries})`);
          await this.sleep(backoffTime);
        } else if (attempt < retries - 1) {
          // Other errors - shorter backoff
          const backoffTime = 500 * (attempt + 1);
          await this.sleep(backoffTime);
        }
      }
    }
    
    throw lastError;
  }
  
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    
    // Reset minute window
    if (now - this.windowStart > 60000) {
      this.requestCount = 0;
      this.windowStart = now;
    }
    
    // Check per-minute limit
    if (this.requestCount >= this.maxRequestsPerMinute) {
      const waitTime = 60000 - (now - this.windowStart);
      console.log(`Minute rate limit reached. Waiting ${waitTime}ms...`);
      await this.sleep(waitTime);
      this.requestCount = 0;
      this.windowStart = Date.now();
    }
    
    // Check per-second limit
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minInterval = 1000 / this.maxRequestsPerSecond;
    
    if (timeSinceLastRequest < minInterval) {
      await this.sleep(minInterval - timeSinceLastRequest);
    }
    
    this.lastRequestTime = Date.now();
    this.requestCount++;
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  // Batch processing with rate limiting
  async processBatch<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    batchSize: number = 5
  ): Promise<R[]> {
    const results: R[] = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      
      const batchPromises = batch.map((item, index) => 
        this.execute(() => processor(item))
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }
      
      // Pause between batches
      if (i + batchSize < items.length) {
        await this.sleep(1000);
      }
    }
    
    return results;
  }
}