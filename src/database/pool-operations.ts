import { Pool } from 'pg';

export interface PoolData {
  pool_address: string;
  base_mint: string;
  quote_mint: string;
  platform: 'pumpfun' | 'raydium_launchpad';
  initial_price?: number;
  initial_base_liquidity?: string;
  initial_quote_liquidity?: string;
  
  // Pump.fun specific
  bonding_curve_address?: string;
  virtual_sol_reserves?: string;
  virtual_token_reserves?: string;
  real_sol_reserves?: string;
  real_token_reserves?: string;
  bonding_curve_progress?: number;
  latest_price?: string;
  
  // Raydium specific
  lp_mint?: string;
  base_vault?: string;
  quote_vault?: string;
}

export class PoolOperations {
  constructor(private pool: Pool) {}

  /**
   * Insert a new pool with token relationship
   * Ensures transactional integrity between token and pool
   */
  async insertPoolWithToken(poolData: PoolData, tokenMint: string): Promise<any> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
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
          initial_price, initial_base_liquidity, initial_quote_liquidity,
          bonding_curve_address, virtual_sol_reserves, virtual_token_reserves,
          real_sol_reserves, real_token_reserves, bonding_curve_progress,
          lp_mint, base_vault, quote_vault, latest_price
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING *
      `;
      
      const poolValues = [
        poolData.pool_address,
        tokenId,
        poolData.base_mint,
        poolData.quote_mint,
        poolData.platform,
        poolData.initial_price,
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
        poolData.latest_price
      ];
      
      const poolResult = await client.query(poolQuery, poolValues);
      
      await client.query('COMMIT');
      return poolResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    
    values.push(bondingCurveAddress);
    
    const query = `
      UPDATE pools 
      SET ${updateFields.join(', ')}, updated_at = NOW()
      WHERE bonding_curve_address = $${paramCount}
    `;
    
    await this.pool.query(query, values);
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
    
    const result = await this.pool.query(query, [poolAddress]);
    return result.rows[0];
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
    
    const result = await this.pool.query(query, [tokenMint]);
    return result.rows;
  }

  /**
   * Update pool status (e.g., when graduated)
   */
  async updatePoolStatus(bondingCurveAddress: string, status: 'active' | 'graduated' | 'closed' | 'failed'): Promise<void> {
    await this.pool.query(
      'UPDATE pools SET status = $1, updated_at = NOW() WHERE bonding_curve_address = $2',
      [status, bondingCurveAddress]
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