import { Pool } from 'pg';
import { getDbPool } from './connection';

export interface Token {
  id?: string;
  mint_address: string;
  symbol?: string;
  name?: string;
  decimals: number;
  platform: 'pumpfun' | 'raydium_launchpad';
  creation_signature: string;
  creation_timestamp: Date;
  creator_address: string;
  initial_supply?: string;
  metadata?: any;
  is_graduated?: boolean;
  graduation_timestamp?: Date;
  graduation_signature?: string;
}

export class TokenOperations {
  private pool: Pool;

  constructor() {
    this.pool = getDbPool();
  }

  /**
   * Insert a new token
   */
  async insertToken(token: Token): Promise<Token> {
    const query = `
      INSERT INTO tokens (
        mint_address, symbol, name, decimals, platform,
        creation_signature, creation_timestamp, creator_address,
        initial_supply, metadata, is_graduated, graduation_timestamp, graduation_signature
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (mint_address) DO UPDATE SET
        symbol = EXCLUDED.symbol,
        name = EXCLUDED.name,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `;

    const values = [
      token.mint_address,
      token.symbol,
      token.name,
      token.decimals,
      token.platform,
      token.creation_signature,
      token.creation_timestamp,
      token.creator_address,
      token.initial_supply,
      token.metadata,
      token.is_graduated || false,
      token.graduation_timestamp,
      token.graduation_signature
    ];

    const result = await this.pool.query(query, values);
    return result.rows[0];
  }

  /**
   * Get token by mint address
   */
  async getTokenByMint(mintAddress: string): Promise<Token | null> {
    const query = 'SELECT * FROM tokens WHERE mint_address = $1';
    const result = await this.pool.query(query, [mintAddress]);
    return result.rows[0] || null;
  }

  /**
   * Get token by ID
   */
  async getTokenById(id: string): Promise<Token | null> {
    const query = 'SELECT * FROM tokens WHERE id = $1';
    const result = await this.pool.query(query, [id]);
    return result.rows[0] || null;
  }

  /**
   * Get tokens by platform
   */
  async getTokensByPlatform(platform: 'pumpfun' | 'raydium_launchpad', limit: number = 100): Promise<Token[]> {
    const query = `
      SELECT * FROM tokens 
      WHERE platform = $1 
      ORDER BY creation_timestamp DESC 
      LIMIT $2
    `;
    const result = await this.pool.query(query, [platform, limit]);
    return result.rows;
  }

  /**
   * Update token graduation status
   */
  async updateGraduationStatus(
    mintAddress: string, 
    graduationSignature: string, 
    graduationTimestamp: Date
  ): Promise<Token | null> {
    const query = `
      UPDATE tokens 
      SET 
        is_graduated = true,
        graduation_signature = $2,
        graduation_timestamp = $3,
        updated_at = NOW()
      WHERE mint_address = $1
      RETURNING *
    `;
    
    const result = await this.pool.query(query, [
      mintAddress,
      graduationSignature,
      graduationTimestamp
    ]);
    
    return result.rows[0] || null;
  }

  /**
   * Get recent tokens
   */
  async getRecentTokens(limit: number = 50): Promise<Token[]> {
    const query = `
      SELECT * FROM tokens 
      ORDER BY creation_timestamp DESC 
      LIMIT $1
    `;
    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  /**
   * Count tokens by platform
   */
  async countTokensByPlatform(): Promise<{ platform: string; count: number }[]> {
    const query = `
      SELECT platform, COUNT(*) as count 
      FROM tokens 
      GROUP BY platform
    `;
    const result = await this.pool.query(query);
    return result.rows;
  }
}

// Export singleton instance
export const tokenOperations = new TokenOperations();