import { BaseOperations } from '../base-operations';
import { PoolClient } from 'pg';
import { Pool, PoolData as LegacyPoolData } from '../types';

// Re-export types for backward compatibility
export type { Pool };
export type PoolData = LegacyPoolData;

export class PoolOperations extends BaseOperations {
  constructor() {
    super();
  }

  /**
   * Create a new pool (MonitorService compatibility)
   */
  async create(pool: Omit<Pool, 'id'>): Promise<string> {
    // Map to existing database columns
    const query = `
      INSERT INTO pools (
        pool_address, token_id, base_mint, quote_mint, platform,
        initial_price, 
        initial_base_liquidity, initial_quote_liquidity,
        bonding_curve_address, virtual_sol_reserves, virtual_token_reserves,
        real_sol_reserves, real_token_reserves, bonding_curve_progress,
        lp_mint, base_vault, quote_vault
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (pool_address) DO UPDATE SET
        virtual_sol_reserves = EXCLUDED.virtual_sol_reserves,
        virtual_token_reserves = EXCLUDED.virtual_token_reserves,
        real_sol_reserves = EXCLUDED.real_sol_reserves,
        real_token_reserves = EXCLUDED.real_token_reserves,
        bonding_curve_progress = EXCLUDED.bonding_curve_progress,
        updated_at = NOW()
      RETURNING id
    `;

    // Calculate initial price if we have reserves
    let initialPrice = pool.initial_price;
    if (!initialPrice && pool.virtual_sol_reserves && pool.virtual_token_reserves) {
      const solReserves = BigInt(pool.virtual_sol_reserves);
      const tokenReserves = BigInt(pool.virtual_token_reserves);
      if (tokenReserves > 0n) {
        initialPrice = Number(solReserves) / 1e9 / (Number(tokenReserves) / 1e6);
      }
    }

    const values = [
      pool.pool_address,
      pool.token_id,
      pool.base_mint || pool.pool_address, // Use pool address as base_mint if not provided
      pool.quote_mint || 'So11111111111111111111111111111111111111112', // WSOL
      pool.platform,
      initialPrice || null,
      pool.initial_base_liquidity || pool.initial_virtual_token_reserves || pool.virtual_token_reserves || null,
      pool.initial_quote_liquidity || pool.initial_virtual_sol_reserves || pool.virtual_sol_reserves || null,
      pool.bonding_curve_address || null,
      pool.virtual_sol_reserves || null,
      pool.virtual_token_reserves || null,
      pool.real_sol_reserves || null,
      pool.real_token_reserves || null,
      pool.bonding_curve_progress || null,
      pool.lp_mint || null,
      pool.base_vault || null,
      pool.quote_vault || null
    ];

    const result = await this.queryOne<{ id: string }>(query, values);
    return result!.id;
  }

  /**
   * Get pool by address (MonitorService compatibility)
   */
  async getByAddress(poolAddress: string): Promise<Pool | null> {
    const query = 'SELECT * FROM pools WHERE pool_address = $1';
    return await this.queryOne<Pool>(query, [poolAddress]);
  }

  /**
   * Get pools by token ID (MonitorService compatibility)
   */
  async getByTokenId(tokenId: string): Promise<Pool[]> {
    const query = `
      SELECT * FROM pools 
      WHERE token_id = $1 
      ORDER BY created_at DESC
    `;
    return await this.queryMany<Pool>(query, [tokenId]);
  }

  /**
   * Insert a new pool with token relationship
   * Ensures transactional integrity between token and pool
   */
  async insertPoolWithToken(poolData: PoolData, tokenMint: string): Promise<any> {
    return this.executeInTransaction(async (client: PoolClient) => {
      // Get token ID from mint address
      const tokenResult = await client.query(
        'SELECT id, platform FROM tokens WHERE mint_address = $1',
        [tokenMint]
      );
      
      if (!tokenResult.rows[0]) {
        throw new Error(`Token not found with mint address: ${tokenMint}`);
      }
      
      const tokenId = tokenResult.rows[0].id;
      const tokenPlatform = tokenResult.rows[0].platform;
      
      // Validate platform consistency
      if (tokenPlatform !== poolData.platform) {
        throw new Error(`Platform mismatch: token is ${tokenPlatform}, pool is ${poolData.platform}`);
      }
      
      // Insert pool
      const poolQuery = `
        INSERT INTO pools (
          pool_address, token_id, base_mint, quote_mint, platform,
          initial_price, initial_price_usd, initial_base_liquidity, initial_quote_liquidity,
          bonding_curve_address, virtual_sol_reserves, virtual_token_reserves,
          real_sol_reserves, real_token_reserves, bonding_curve_progress,
          lp_mint, base_vault, quote_vault, latest_price, latest_price_usd
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        RETURNING *
      `;
      
      const poolValues = [
        poolData.pool_address,
        tokenId,
        poolData.base_mint,
        poolData.quote_mint,
        poolData.platform,
        poolData.initial_price,
        poolData.initial_price_usd,
        poolData.initial_base_liquidity,
        poolData.initial_quote_liquidity,
        poolData.bonding_curve_address,
        poolData.virtual_sol_reserves,
        poolData.virtual_token_reserves,
        poolData.real_sol_reserves,
        poolData.real_token_reserves,
        poolData.bonding_curve_progress,
        poolData.lp_mint,
        poolData.base_vault,
        poolData.quote_vault,
        poolData.latest_price,
        poolData.latest_price_usd
      ];
      
      const poolResult = await client.query(poolQuery, poolValues);
      return poolResult.rows[0];
    });
  }

  /**
   * Update pool reserves (for Pump.fun bonding curves)
   */
  async updatePoolReserves(bondingCurveAddress: string, reserves: {
    virtual_sol_reserves?: string;
    virtual_token_reserves?: string;
    real_sol_reserves?: string;
    real_token_reserves?: string;
    bonding_curve_progress?: number;
    latest_price?: string;
  }): Promise<void> {
    const updateFields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;
    
    Object.entries(reserves).forEach(([key, value]) => {
      if (value !== undefined) {
        updateFields.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    });
    
    if (updateFields.length === 0) {
      return;
    }
    
    // Also update bonding_curve_address field if not already set
    updateFields.push(`bonding_curve_address = $${paramCount}`);
    values.push(bondingCurveAddress);
    paramCount++;
    
    values.push(bondingCurveAddress);
    
    // For Pump.fun, the bonding curve address IS the pool address
    const query = `
      UPDATE pools 
      SET ${updateFields.join(', ')}, updated_at = NOW()
      WHERE pool_address = $${paramCount}
    `;
    
    await this.execute(query, values);
  }

  /**
   * Get pool by address with token information
   */
  async getPoolWithToken(poolAddress: string): Promise<any> {
    const query = `
      SELECT 
        p.*,
        t.mint_address,
        t.symbol,
        t.name,
        t.decimals,
        t.creator_address,
        t.is_graduated
      FROM pools p
      JOIN tokens t ON p.token_id = t.id
      WHERE p.pool_address = $1
    `;
    
    return await this.queryOne(query, [poolAddress]);
  }

  /**
   * Get all pools for a token
   */
  async getPoolsByTokenMint(tokenMint: string): Promise<any[]> {
    const query = `
      SELECT p.*
      FROM pools p
      JOIN tokens t ON p.token_id = t.id
      WHERE t.mint_address = $1
      ORDER BY p.created_at DESC
    `;
    
    return await this.queryMany(query, [tokenMint]);
  }

  /**
   * Update pool status (e.g., when graduated)
   */
  async updatePoolStatus(bondingCurveAddress: string, status: 'active' | 'graduated' | 'closed' | 'failed'): Promise<void> {
    // For Pump.fun, the bonding curve address IS the pool address
    await this.execute(
      'UPDATE pools SET status = $1, updated_at = NOW() WHERE pool_address = $2',
      [status, bondingCurveAddress]
    );
  }

  /**
   * Update pool metadata
   */
  async updatePoolMetadata(poolAddress: string, metadata: any): Promise<void> {
    await this.execute(
      'UPDATE pools SET metadata = $1, updated_at = NOW() WHERE pool_address = $2',
      [JSON.stringify(metadata), poolAddress]
    );
  }

  /**
   * Calculate initial price from reserves
   */
  calculateInitialPrice(baseReserves: string, quoteReserves: string, baseDecimals: number, quoteDecimals: number): number {
    const base = BigInt(baseReserves);
    const quote = BigInt(quoteReserves);
    
    if (base === BigInt(0)) {
      return 0;
    }
    
    // Price = quote / base, adjusted for decimals
    const price = Number(quote) / Number(base);
    const decimalAdjustment = Math.pow(10, baseDecimals - quoteDecimals);
    
    return price * decimalAdjustment;
  }
}