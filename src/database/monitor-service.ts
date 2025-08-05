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

  /**
   * Save holder score to database
   */
  async saveHolderScore(tokenMint: string, score: any): Promise<any> {
    try {
      // First get the token ID
      const token = await this.tokenOps.getByMintAddress(tokenMint);
      
      if (!token) {
        console.error(`Token not found: ${tokenMint}`);
        return null;
      }
      
      const tokenId = token.id!;
      
      // Insert holder score
      const query = `
        INSERT INTO holder_scores (
          token_id, score_time, bonding_curve_progress,
          distribution_score, quality_score, activity_score, total_score,
          gini_coefficient, top_10_concentration, unique_holders,
          avg_wallet_age_days, bot_ratio, organic_growth_score,
          score_details, red_flags, yellow_flags, positive_signals
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (token_id, score_time) DO UPDATE SET
          distribution_score = $4,
          quality_score = $5,
          activity_score = $6,
          total_score = $7,
          gini_coefficient = $8,
          top_10_concentration = $9,
          unique_holders = $10,
          avg_wallet_age_days = $11,
          bot_ratio = $12,
          organic_growth_score = $13,
          score_details = $14,
          red_flags = $15,
          yellow_flags = $16,
          positive_signals = $17
        RETURNING *
      `;
      
      const values = [
        tokenId,
        new Date(),
        score.bondingCurveProgress,
        Math.round(score.distribution),
        Math.round(score.quality),
        Math.round(score.activity),
        Math.round(score.total),
        score.details.giniCoefficient,
        score.details.top10Concentration,
        score.details.uniqueHolders,
        score.details.avgWalletAge,
        score.details.botRatio,
        score.details.organicGrowthScore,
        JSON.stringify(score.details),
        score.redFlags || [],
        score.yellowFlags || [],
        score.positiveSignals || []
      ];
      
      const result = await this.queryOne(query, values);
      console.log(`💾 Saved holder score for ${tokenMint}: ${score.total}/333`);
      
      return result;
    } catch (error) {
      console.error('Error saving holder score:', error);
      return null;
    }
  }

  /**
   * Get latest holder score for a token
   */
  async getLatestHolderScore(tokenMint: string): Promise<any> {
    try {
      const query = `
        SELECT hs.*, t.symbol, t.name
        FROM holder_scores hs
        JOIN tokens t ON hs.token_id = t.id
        WHERE t.mint_address = $1
        ORDER BY hs.score_time DESC
        LIMIT 1
      `;
      
      const result = await this.queryOne(query, [tokenMint]);
      return result || null;
    } catch (error) {
      console.error('Error fetching holder score:', error);
      return null;
    }
  }
}

// Export singleton instance
export const monitorService = new MonitorService();

// Export holder score functions for backward compatibility
export const saveHolderScore = (tokenMint: string, score: any) => 
  monitorService.saveHolderScore(tokenMint, score);

export const getLatestHolderScore = (tokenMint: string) => 
  monitorService.getLatestHolderScore(tokenMint);