import { Pool } from 'pg';
import { DatabaseConnection } from '../../database/connection';
import { GraduatedTokenData } from './types';
import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';

export class GraduatedTokenFetcher {
  private pool: Pool;
  private connection: Connection;
  private heliusApiKey: string | undefined;
  
  constructor() {
    this.pool = DatabaseConnection.getPool();
    this.connection = new Connection(
      process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com'
    );
    this.heliusApiKey = process.env.HELIUS_API_KEY;
  }

  /**
   * Fetch graduated tokens from the database
   */
  async fetchGraduatedTokensFromDB(limit: number = 1000): Promise<GraduatedTokenData[]> {
    console.log(`Fetching graduated tokens from database (limit: ${limit})...`);
    
    const query = `
      SELECT 
        gt.token_mint as mint_address,
        gt.graduation_timestamp,
        gt.graduation_signature,
        gt.migration_type as migration_platform,
        gt.graduation_price,
        gt.graduation_market_cap as final_market_cap,
        t.symbol,
        t.name
      FROM graduated_tokens gt
      LEFT JOIN tokens t ON gt.token_mint = t.mint_address
      WHERE gt.graduation_timestamp IS NOT NULL
      ORDER BY gt.graduation_timestamp DESC
      LIMIT $1`;
    
    const result = await this.pool.query(query, [limit]);
    
    const tokens: GraduatedTokenData[] = result.rows.map(row => ({
      mint_address: row.mint_address,
      graduation_timestamp: row.graduation_timestamp,
      graduation_signature: row.graduation_signature || '',
      graduation_price: row.graduation_price || 0,
      peak_price: undefined, // Will be calculated separately
      final_market_cap: row.final_market_cap || undefined,
      migration_platform: this.normalizePlatform(row.migration_platform),
      data_source: 'local_cache',
      validation_status: 'verified'
    }));

    console.log(`Found ${tokens.length} graduated tokens in database`);
    return tokens;
  }

  /**
   * Fetch graduated tokens from Helius API (fallback)
   */
  async fetchGraduatedTokensFromHelius(
    startTime?: Date,
    endTime?: Date
  ): Promise<GraduatedTokenData[]> {
    if (!this.heliusApiKey) {
      console.warn('Helius API key not configured, skipping Helius fetch');
      return [];
    }

    console.log('Fetching graduated tokens from Helius API...');
    
    try {
      // This is a placeholder - actual Helius API integration would go here
      // The exact endpoint and parameters would depend on Helius API documentation
      const response = await axios.post(
        `https://api.helius.xyz/v0/addresses/transactions`,
        {
          addresses: ['39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg'], // Raydium migration address
          type: 'TRANSFER',
          startTime: startTime?.toISOString(),
          endTime: endTime?.toISOString()
        },
        {
          headers: {
            'Authorization': `Bearer ${this.heliusApiKey}`
          }
        }
      );

      // Parse response and extract graduated tokens
      // This would need to be implemented based on actual API response format
      return [];
    } catch (error) {
      console.error('Error fetching from Helius:', error);
      return [];
    }
  }

  /**
   * Validate graduated token data
   */
  async validateGraduatedToken(token: GraduatedTokenData): Promise<boolean> {
    try {
      // Check if graduation signature exists on-chain
      if (token.graduation_signature && token.graduation_signature !== '') {
        const signature = await this.connection.getTransaction(
          token.graduation_signature,
          { maxSupportedTransactionVersion: 0 }
        );
        
        if (!signature) {
          console.warn(`Graduation signature not found for ${token.mint_address}`);
          return false;
        }
      }

      // Validate graduation timestamp is reasonable
      const now = new Date();
      const graduationTime = new Date(token.graduation_timestamp);
      
      if (graduationTime > now) {
        console.warn(`Future graduation time for ${token.mint_address}`);
        return false;
      }
      
      // Token must have graduated within last year
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      
      if (graduationTime < oneYearAgo) {
        console.warn(`Very old graduation for ${token.mint_address}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error(`Error validating token ${token.mint_address}:`, error);
      return false;
    }
  }

  /**
   * Get peak price for a graduated token
   */
  async getTokenPeakPrice(mintAddress: string): Promise<number | undefined> {
    const query = `
      SELECT MAX(pc.high) as peak_price
      FROM price_candles_1m pc
      JOIN tokens t ON pc.token_id = t.id
      WHERE t.mint_address = $1`;
    
    const result = await this.pool.query(query, [mintAddress]);
    return result.rows[0]?.peak_price || undefined;
  }

  /**
   * Fetch and validate all graduated tokens
   */
  async fetchAllGraduatedTokens(): Promise<GraduatedTokenData[]> {
    console.log('Starting graduated token fetch...');
    
    // First, get tokens from database
    const dbTokens = await this.fetchGraduatedTokensFromDB();
    
    // If we have tokens, validate them
    const validatedTokens: GraduatedTokenData[] = [];
    
    for (const token of dbTokens) {
      const isValid = await this.validateGraduatedToken(token);
      if (isValid) {
        // Get peak price
        token.peak_price = await this.getTokenPeakPrice(token.mint_address);
        validatedTokens.push(token);
      }
    }

    console.log(`Validated ${validatedTokens.length} out of ${dbTokens.length} tokens`);
    
    // If we don't have enough tokens, try fetching from external sources
    if (validatedTokens.length < 10 && this.heliusApiKey) {
      console.log('Insufficient tokens, fetching from external sources...');
      const externalTokens = await this.fetchGraduatedTokensFromHelius();
      
      for (const token of externalTokens) {
        // Check if we already have this token
        if (!validatedTokens.find(t => t.mint_address === token.mint_address)) {
          const isValid = await this.validateGraduatedToken(token);
          if (isValid) {
            validatedTokens.push(token);
          }
        }
      }
    }

    return validatedTokens;
  }

  /**
   * Get graduated tokens within a specific time range
   */
  async getGraduatedTokensInRange(
    startDate: Date,
    endDate: Date
  ): Promise<GraduatedTokenData[]> {
    const query = `
      SELECT 
        gt.token_mint as mint_address,
        gt.graduation_timestamp,
        gt.graduation_signature,
        gt.migration_type as migration_platform,
        gt.graduation_price,
        gt.graduation_market_cap as final_market_cap
      FROM graduated_tokens gt
      WHERE gt.graduation_timestamp BETWEEN $1 AND $2
        AND gt.graduation_timestamp IS NOT NULL
      ORDER BY gt.graduation_timestamp DESC`;
    
    const result = await this.pool.query(query, [startDate, endDate]);
    
    return result.rows.map(row => ({
      mint_address: row.mint_address,
      graduation_timestamp: row.graduation_timestamp,
      graduation_signature: row.graduation_signature || '',
      graduation_price: row.graduation_price || 0,
      peak_price: undefined,
      final_market_cap: row.final_market_cap || undefined,
      migration_platform: this.normalizePlatform(row.migration_platform),
      data_source: 'local_cache',
      validation_status: 'verified'
    }));
  }

  /**
   * Save graduated token to database if not exists
   */
  async saveGraduatedToken(token: GraduatedTokenData): Promise<void> {
    const query = `
      INSERT INTO graduated_tokens (
        token_mint,
        graduation_timestamp,
        graduation_signature,
        migration_type,
        created_at
      ) VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (token_mint) DO UPDATE SET
        graduation_timestamp = EXCLUDED.graduation_timestamp,
        graduation_signature = EXCLUDED.graduation_signature,
        migration_type = EXCLUDED.migration_type,
        updated_at = NOW()`;
    
    await this.pool.query(query, [
      token.mint_address,
      token.graduation_timestamp,
      token.graduation_signature,
      token.migration_platform
    ]);
  }

  /**
   * Get statistics about graduated tokens
   */
  async getGraduationStats(): Promise<any> {
    const query = `
      SELECT 
        COUNT(*) as total_graduated,
        COUNT(DISTINCT DATE(graduation_timestamp)) as days_with_graduations,
        MIN(graduation_timestamp) as first_graduation,
        MAX(graduation_timestamp) as latest_graduation,
        COUNT(*) FILTER (WHERE migration_type = 'raydium') as raydium_graduations,
        COUNT(*) FILTER (WHERE migration_type = 'meteora') as meteora_graduations
      FROM graduated_tokens
      WHERE graduation_timestamp IS NOT NULL`;
    
    const result = await this.pool.query(query);
    return result.rows[0];
  }

  private normalizePlatform(platform: string): 'raydium' | 'meteora' | 'other' {
    const normalized = platform?.toLowerCase();
    if (normalized === 'raydium') return 'raydium';
    if (normalized === 'meteora') return 'meteora';
    return 'other';
  }
}

export const graduatedTokenFetcher = new GraduatedTokenFetcher();