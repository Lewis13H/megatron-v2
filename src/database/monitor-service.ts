import { TokenOperations } from './operations/token';
import { PoolOperations } from './operations/pool';
import { TransactionOperations } from './operations/transaction';
import { PriceOperations } from './operations/price';
import { BaseOperations } from './base-operations';
import { Transaction, TokenData, MonitorPoolData, TransactionData, PriceData } from './types';

// Re-export types for backward compatibility
export type { TokenData, TransactionData, PriceData };
export type PoolData = MonitorPoolData;

/**
 * Unified service for all monitor database operations
 * Consolidates monitor-integration.ts and transaction-monitor-integration.ts
 */
export class MonitorService extends BaseOperations {
  private tokenOps: TokenOperations;
  private poolOps: PoolOperations;
  private txOps: TransactionOperations;
  private priceOps: PriceOperations;
  
  // Simple cache for token/pool lookups
  private tokenPoolCache: Map<string, { tokenId: string; poolId: string }> = new Map();
  private CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private cacheTimestamps: Map<string, number> = new Map();

  constructor() {
    super();
    this.tokenOps = new TokenOperations();
    this.poolOps = new PoolOperations();
    this.txOps = new TransactionOperations();
    this.priceOps = new PriceOperations();
  }

  /**
   * Save token data with automatic duplicate handling
   */
  async saveToken(data: TokenData): Promise<string> {
    try {
      // First, try to get existing token
      const existing = await this.tokenOps.getByMintAddress(data.mint_address);
      if (existing) {
        console.log(`Token ${data.mint_address} already exists with ID: ${existing.id}`);
        return existing.id!;
      }

      // Create new token with defaults
      const tokenId = await this.tokenOps.create({
        ...data,
        symbol: data.symbol || 'UNKNOWN',
        name: data.name || 'Unknown Token',
        decimals: data.decimals || 9
      });
      console.log(`Created new token ${data.mint_address} with ID: ${tokenId}`);
      
      // Clear cache for this mint address
      this.clearCacheEntry(data.mint_address);
      
      return tokenId;
    } catch (error: any) {
      if (error.code === '23505') { // Unique constraint violation
        // Try to fetch again in case of race condition
        const existing = await this.tokenOps.getByMintAddress(data.mint_address);
        if (existing) {
          return existing.id!;
        }
      }
      throw error;
    }
  }

  /**
   * Save pool data with automatic duplicate handling
   */
  async savePool(data: PoolData): Promise<string> {
    try {
      // Check if pool exists
      const existing = await this.poolOps.getByAddress(data.pool_address);
      if (existing) {
        console.log(`Pool ${data.pool_address} already exists with ID: ${existing.id}`);
        return existing.id!;
      }

      // Create new pool with required fields
      const poolData = {
        ...data,
        base_mint: data.pool_address, // Use pool address as base_mint if not provided
        quote_mint: 'So11111111111111111111111111111111111111112' // WSOL as default quote
      };

      const poolId = await this.poolOps.create(poolData as any);
      console.log(`Created new pool ${data.pool_address} with ID: ${poolId}`);
      
      // Clear cache for associated token
      const token = await this.tokenOps.getById(data.token_id);
      if (token) {
        this.clearCacheEntry(token.mint_address);
      }
      
      return poolId;
    } catch (error: any) {
      if (error.code === '23505') { // Unique constraint violation
        const existing = await this.poolOps.getByAddress(data.pool_address);
        if (existing) {
          return existing.id!;
        }
      }
      throw error;
    }
  }

  /**
   * Save single transaction
   */
  async saveTransaction(data: TransactionData): Promise<void> {
    // If we have mint_address but no token_id/pool_id, resolve them
    if (data.mint_address && (!data.token_id || !data.pool_id)) {
      const ids = await this.getTokenAndPoolIds(data.mint_address, data.pool_address);
      if (ids) {
        data.token_id = ids.tokenId;
        data.pool_id = ids.poolId;
      } else {
        console.warn(`Could not resolve token/pool for mint ${data.mint_address}`);
        return;
      }
    }

    await this.txOps.create({
      signature: data.signature,
      pool_id: data.pool_id!,
      token_id: data.token_id!,
      block_time: data.block_time,
      slot: data.slot,
      type: data.type,
      user_address: data.user_address,
      sol_amount: data.sol_amount,
      token_amount: data.token_amount,
      price_per_token: data.price_per_token,
      pre_tx_sol_reserves: data.pre_tx_sol_reserves,
      pre_tx_token_reserves: data.pre_tx_token_reserves,
      post_tx_sol_reserves: data.post_tx_sol_reserves,
      post_tx_token_reserves: data.post_tx_token_reserves,
      fee_sol: data.fee_sol,
      fee_token: data.fee_token,
      metadata: data.metadata
    });
  }

  /**
   * Save batch of transactions efficiently
   */
  async saveTransactionBatch(transactions: TransactionData[]): Promise<void> {
    if (transactions.length === 0) return;

    // Resolve all token/pool IDs first
    const resolvedTxs: Transaction[] = [];
    
    for (const tx of transactions) {
      if (tx.mint_address && (!tx.token_id || !tx.pool_id)) {
        const ids = await this.getTokenAndPoolIds(tx.mint_address, tx.pool_address);
        if (!ids) {
          console.warn(`Skipping transaction ${tx.signature} - could not resolve token/pool`);
          continue;
        }
        tx.token_id = ids.tokenId;
        tx.pool_id = ids.poolId;
      }

      if (tx.token_id && tx.pool_id) {
        resolvedTxs.push({
          signature: tx.signature,
          pool_id: tx.pool_id,
          token_id: tx.token_id,
          block_time: tx.block_time,
          slot: tx.slot,
          type: tx.type,
          user_address: tx.user_address,
          sol_amount: tx.sol_amount,
          token_amount: tx.token_amount,
          price_per_token: tx.price_per_token,
          pre_tx_sol_reserves: tx.pre_tx_sol_reserves,
          pre_tx_token_reserves: tx.pre_tx_token_reserves,
          post_tx_sol_reserves: tx.post_tx_sol_reserves,
          post_tx_token_reserves: tx.post_tx_token_reserves,
          fee_sol: tx.fee_sol,
          fee_token: tx.fee_token,
          metadata: tx.metadata
        });
      }
    }

    // Use batch operation
    await this.txOps.createBatch(resolvedTxs);
  }

  /**
   * Save price data
   */
  async savePrice(data: PriceData): Promise<void> {
    await this.priceOps.recordPrice(
      data.pool_id,
      data.price_sol,
      data.price_usd,
      data.volume_sol,
      data.volume_usd,
      data.timestamp
    );
  }

  /**
   * Get latest SOL price using SQL function
   */
  async getLatestSolPrice(): Promise<number | null> {
    const result = await this.queryOne<{ price: number }>(
      'SELECT get_latest_sol_usd_price() as price'
    );
    return result?.price || null;
  }

  /**
   * Get or resolve token and pool IDs from mint address
   */
  private async getTokenAndPoolIds(
    mintAddress: string,
    poolAddress?: string
  ): Promise<{ tokenId: string; poolId: string } | null> {
    // Check cache first
    const cached = this.getCacheEntry(mintAddress);
    if (cached) {
      return cached;
    }

    try {
      // Get token ID
      const token = await this.tokenOps.getByMintAddress(mintAddress);
      if (!token) {
        console.warn(`Token not found for mint address: ${mintAddress}`);
        return null;
      }

      // Get pool ID - try by pool address first, then by token
      let pool;
      if (poolAddress) {
        pool = await this.poolOps.getByAddress(poolAddress);
      }
      
      if (!pool && token.id) {
        // Get primary pool for token
        const pools = await this.poolOps.getByTokenId(token.id);
        pool = pools[0]; // Use first pool
      }

      if (!pool) {
        console.warn(`No pool found for token: ${mintAddress}`);
        return null;
      }

      const result = { tokenId: token.id!, poolId: pool.id! };
      this.setCacheEntry(mintAddress, result);
      return result;
    } catch (error) {
      console.error(`Error resolving token/pool for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * Cache management methods
   */
  private getCacheEntry(key: string): { tokenId: string; poolId: string } | null {
    const timestamp = this.cacheTimestamps.get(key);
    if (!timestamp || Date.now() - timestamp > this.CACHE_TTL) {
      this.tokenPoolCache.delete(key);
      this.cacheTimestamps.delete(key);
      return null;
    }
    return this.tokenPoolCache.get(key) || null;
  }

  private setCacheEntry(key: string, value: { tokenId: string; poolId: string }): void {
    this.tokenPoolCache.set(key, value);
    this.cacheTimestamps.set(key, Date.now());
  }

  private clearCacheEntry(key: string): void {
    this.tokenPoolCache.delete(key);
    this.cacheTimestamps.delete(key);
  }

  /**
   * Clear entire cache
   */
  clearCache(): void {
    this.tokenPoolCache.clear();
    this.cacheTimestamps.clear();
  }
}

// Export singleton instance
export const monitorService = new MonitorService();