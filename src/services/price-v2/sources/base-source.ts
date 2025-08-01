import { PriceSource, PriceData, PriceSourceConfig } from '../types';

export abstract class BasePriceSource implements PriceSource {
  protected lastError: Error | null = null;
  protected lastSuccessTime: Date | null = null;
  protected consecutiveFailures: number = 0;
  
  constructor(
    public readonly name: string,
    protected readonly config: PriceSourceConfig
  ) {}
  
  abstract fetchPrice(): Promise<PriceData>;
  
  async fetchWithRetry(): Promise<PriceData> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      try {
        const data = await this.withTimeout(this.fetchPrice());
        this.lastError = null;
        this.lastSuccessTime = new Date();
        this.consecutiveFailures = 0;
        return data;
      } catch (error) {
        lastError = error as Error;
        this.lastError = lastError;
        this.consecutiveFailures++;
        
        if (attempt < this.config.retryCount) {
          await this.delay(this.config.retryDelay * Math.pow(2, attempt));
        }
      }
    }
    
    throw lastError || new Error('Unknown error');
  }
  
  isHealthy(): boolean {
    // Consider healthy if successful in last 5 minutes and less than 5 consecutive failures
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return (
      this.consecutiveFailures < 5 &&
      this.lastSuccessTime !== null &&
      this.lastSuccessTime > fiveMinutesAgo
    );
  }
  
  getLastError(): Error | null {
    return this.lastError;
  }
  
  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Timeout')), this.config.timeout);
    });
    
    return Promise.race([promise, timeoutPromise]);
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}