import { BaseOperations } from '../base-operations';
import { Token } from '../types';

// Re-export Token type for backward compatibility
export type { Token };

export class TokenOperations extends BaseOperations {
  constructor() {
    super();
  }

  /**
   * Create a new token (returns just the ID for MonitorService compatibility)
   */
  async create(token: Omit<Token, 'id'>): Promise<string> {
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
      RETURNING id
    `;

    const values = [
      token.mint_address,
      token.symbol,
      token.name,
      token.decimals || 9,
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

    const result = await this.queryOne<{ id: string }>(query, values);
    return result!.id;
  }

  /**
   * Insert a new token (legacy method, returns full token)
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

    return await this.queryOne<Token>(query, values) as Token;
  }

  /**
   * Get token by mint address (MonitorService compatibility)
   */
  async getByMintAddress(mintAddress: string): Promise<Token | null> {
    const query = 'SELECT * FROM tokens WHERE mint_address = $1';
    return await this.queryOne<Token>(query, [mintAddress]);
  }

  /**
   * Get token by mint address (legacy method)
   */
  async getTokenByMint(mintAddress: string): Promise<Token | null> {
    return this.getByMintAddress(mintAddress);
  }

  /**
   * Get token by ID (MonitorService compatibility)
   */
  async getById(id: string): Promise<Token | null> {
    const query = 'SELECT * FROM tokens WHERE id = $1';
    return await this.queryOne<Token>(query, [id]);
  }

  /**
   * Get token by ID (legacy method)
   */
  async getTokenById(id: string): Promise<Token | null> {
    return this.getById(id);
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
    return await this.queryMany<Token>(query, [platform, limit]);
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
    
    return await this.queryOne<Token>(query, [
      mintAddress,
      graduationSignature,
      graduationTimestamp
    ]);
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
    return await this.queryMany<Token>(query, [limit]);
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
    return await this.queryMany<{ platform: string; count: number }>(query);
  }
}

// Export singleton instance
export const tokenOperations = new TokenOperations();