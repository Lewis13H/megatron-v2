import { PriceData } from './types';

interface CacheEntry {
  data: PriceData;
  expiresAt: Date;
}

export class PriceCache {
  private cache = new Map<string, CacheEntry>();
  
  constructor(private readonly cacheDuration: number) {}
  
  set(key: string, data: PriceData): void {
    const expiresAt = new Date(Date.now() + this.cacheDuration);
    this.cache.set(key, { data, expiresAt });
  }
  
  get(key: string): PriceData | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }
    
    if (entry.expiresAt < new Date()) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data;
  }
  
  getAll(): PriceData[] {
    const now = new Date();
    const validEntries: PriceData[] = [];
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt < now) {
        this.cache.delete(key);
      } else {
        validEntries.push(entry.data);
      }
    }
    
    return validEntries;
  }
  
  clear(): void {
    this.cache.clear();
  }
  
  size(): number {
    return this.cache.size;
  }
}