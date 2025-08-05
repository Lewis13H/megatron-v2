/**
 * Simple in-memory cache with TTL support
 * Used for caching frequently accessed data like token/pool lookups
 */
export class SimpleCache<T> {
  private cache = new Map<string, { value: T; expires: number }>();
  private ttl: number;
  
  constructor(ttlSeconds = 300) { // 5 minutes default
    this.ttl = ttlSeconds * 1000;
  }
  
  /**
   * Get value from cache
   */
  get(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) return null;
    
    // Check if expired
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return null;
    }
    
    return item.value;
  }
  
  /**
   * Set value in cache
   */
  set(key: string, value: T): void {
    this.cache.set(key, {
      value,
      expires: Date.now() + this.ttl
    });
  }
  
  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    const item = this.cache.get(key);
    if (!item) return false;
    
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }
  
  /**
   * Delete specific key
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }
  
  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }
  
  /**
   * Get cache size
   */
  get size(): number {
    // Clean up expired entries first
    this.cleanExpired();
    return this.cache.size;
  }
  
  /**
   * Clean up expired entries
   */
  private cleanExpired(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expires) {
        this.cache.delete(key);
      }
    }
  }
  
  /**
   * Get all keys (excluding expired)
   */
  keys(): string[] {
    this.cleanExpired();
    return Array.from(this.cache.keys());
  }
  
  /**
   * Get cache statistics
   */
  getStats(): { size: number; ttlSeconds: number } {
    return {
      size: this.size,
      ttlSeconds: this.ttl / 1000
    };
  }
}

/**
 * Cache specifically for token metadata
 */
export class TokenCache extends SimpleCache<{
  id: string;
  symbol?: string;
  name?: string;
  decimals?: number;
}> {
  constructor() {
    super(600); // 10 minutes for token data
  }
}

/**
 * Cache specifically for pool data
 */
export class PoolCache extends SimpleCache<{
  id: string;
  token_id: string;
  platform: string;
}> {
  constructor() {
    super(600); // 10 minutes for pool data
  }
}

/**
 * Cache for token-pool ID mapping
 */
export class TokenPoolMappingCache extends SimpleCache<{
  tokenId: string;
  poolId: string;
}> {
  constructor() {
    super(300); // 5 minutes for mapping data
  }
}