import { Pool } from 'pg';
import { DatabaseConnection } from '../../database/connection';
import { TransactionData, WalletTrade } from './types';
import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';

export class TransactionFetcher {
  private pool: Pool;
  private connection: Connection;
  private heliusApiKey: string | undefined;
  private readonly BATCH_SIZE = 100;
  
  constructor() {
    this.pool = DatabaseConnection.getPool();
    this.connection = new Connection(
      process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com'
    );
    this.heliusApiKey = process.env.HELIUS_API_KEY;
  }

  /**
   * Fetch transactions from database for a token
   */
  async fetchTransactionsFromDB(
    tokenMint: string,
    beforeTimestamp?: Date
  ): Promise<TransactionData[]> {
    console.log(`Fetching transactions for ${tokenMint} from database...`);
    
    let query = `
      SELECT 
        t.signature,
        t.block_time,
        t.type,
        t.user_address as wallet,
        tok.mint_address as token_mint,
        t.token_amount as amount,
        t.sol_amount,
        p.latest_price as price
      FROM transactions t
      JOIN tokens tok ON t.token_id = tok.id
      LEFT JOIN pools p ON t.pool_id = p.id
      WHERE tok.mint_address = $1`;
    
    const params: any[] = [tokenMint];
    
    if (beforeTimestamp) {
      query += ` AND t.block_time < $2`;
      params.push(beforeTimestamp);
    }
    
    query += ` ORDER BY t.block_time DESC LIMIT 1000`;
    
    const result = await this.pool.query(query, params);
    
    const transactions: TransactionData[] = result.rows.map(row => ({
      signature: row.signature,
      blockTime: row.block_time,
      type: this.normalizeTransactionType(row.type),
      wallet: row.wallet,
      tokenMint: row.token_mint,
      amount: parseFloat(row.amount || '0'),
      price: parseFloat(row.price || '0'),
      solValue: parseFloat(row.sol_amount || '0')
    }));

    console.log(`Found ${transactions.length} transactions in database`);
    return transactions;
  }

  /**
   * Fetch transactions for graduated token before graduation
   */
  async fetchPreGraduationTransactions(
    tokenMint: string,
    graduationTimestamp: Date
  ): Promise<TransactionData[]> {
    console.log(`Fetching pre-graduation transactions for ${tokenMint}...`);
    
    // First try database
    const dbTransactions = await this.fetchTransactionsFromDB(tokenMint, graduationTimestamp);
    
    // If we have sufficient data, return it
    if (dbTransactions.length > 50) {
      return dbTransactions;
    }
    
    // Otherwise, try external sources
    if (this.heliusApiKey) {
      const externalTransactions = await this.fetchTransactionsFromHelius(
        tokenMint,
        graduationTimestamp
      );
      
      // Merge and deduplicate
      const allTransactions = this.mergeTransactions(dbTransactions, externalTransactions);
      
      // Filter to only pre-graduation
      return allTransactions.filter(tx => 
        new Date(tx.blockTime) < graduationTimestamp
      );
    }
    
    return dbTransactions;
  }

  /**
   * Fetch transactions from Helius API
   */
  async fetchTransactionsFromHelius(
    tokenMint: string,
    beforeTimestamp?: Date
  ): Promise<TransactionData[]> {
    if (!this.heliusApiKey) {
      console.warn('Helius API key not configured');
      return [];
    }

    console.log(`Fetching transactions from Helius for ${tokenMint}...`);
    
    try {
      const response = await axios.post(
        `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions`,
        {
          limit: 1000,
          before: beforeTimestamp?.toISOString()
        },
        {
          headers: {
            'Authorization': `Bearer ${this.heliusApiKey}`
          }
        }
      );

      // Parse Helius response format
      // This is a placeholder - actual parsing would depend on Helius API response
      const transactions: TransactionData[] = [];
      
      if (response.data && Array.isArray(response.data)) {
        for (const tx of response.data) {
          // Extract transaction details from Helius format
          // This would need to be implemented based on actual API response
        }
      }
      
      return transactions;
    } catch (error) {
      console.error('Error fetching from Helius:', error);
      return [];
    }
  }

  /**
   * Extract unique buyers from transactions
   */
  extractUniqueBuyers(transactions: TransactionData[]): Set<string> {
    const buyers = new Set<string>();
    
    for (const tx of transactions) {
      if (tx.type === 'buy' && tx.wallet) {
        buyers.add(tx.wallet);
      }
    }
    
    return buyers;
  }

  /**
   * Get wallet trades from transactions
   */
  convertToWalletTrades(
    transactions: TransactionData[],
    isGraduatedToken: boolean,
    graduationTimestamp?: Date
  ): WalletTrade[] {
    const trades: WalletTrade[] = [];
    
    for (const tx of transactions) {
      const trade: WalletTrade = {
        wallet_address: tx.wallet,
        token_mint: tx.tokenMint,
        trade_type: tx.type,
        amount: tx.amount,
        price_sol: tx.price,
        sol_value: tx.solValue,
        transaction_hash: tx.signature,
        block_time: tx.blockTime,
        is_graduated_token: isGraduatedToken,
        time_to_graduation_minutes: undefined
      };
      
      // Calculate time to graduation if applicable
      if (graduationTimestamp && isGraduatedToken) {
        const tradeTime = new Date(tx.blockTime).getTime();
        const gradTime = graduationTimestamp.getTime();
        const diffMinutes = Math.floor((gradTime - tradeTime) / (1000 * 60));
        
        if (diffMinutes > 0) {
          trade.time_to_graduation_minutes = diffMinutes;
        }
      }
      
      trades.push(trade);
    }
    
    return trades;
  }

  /**
   * Batch fetch transactions for multiple tokens
   */
  async batchFetchTransactions(
    tokenMints: string[],
    beforeTimestamp?: Date
  ): Promise<Map<string, TransactionData[]>> {
    const results = new Map<string, TransactionData[]>();
    
    // Process in batches to avoid overwhelming the database
    for (let i = 0; i < tokenMints.length; i += this.BATCH_SIZE) {
      const batch = tokenMints.slice(i, i + this.BATCH_SIZE);
      
      console.log(`Processing batch ${i / this.BATCH_SIZE + 1} of ${Math.ceil(tokenMints.length / this.BATCH_SIZE)}`);
      
      await Promise.all(
        batch.map(async (mint) => {
          const transactions = await this.fetchTransactionsFromDB(mint, beforeTimestamp);
          results.set(mint, transactions);
        })
      );
      
      // Add small delay between batches
      if (i + this.BATCH_SIZE < tokenMints.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return results;
  }

  /**
   * Get transaction volume statistics for a token
   */
  async getTokenTransactionStats(tokenMint: string): Promise<any> {
    const query = `
      SELECT 
        COUNT(*) as total_transactions,
        COUNT(DISTINCT signer) as unique_wallets,
        COUNT(*) FILTER (WHERE type = 'buy') as buy_count,
        COUNT(*) FILTER (WHERE type = 'sell') as sell_count,
        SUM(sol_amount) as total_volume_sol,
        AVG(sol_amount) as avg_trade_size_sol,
        MIN(block_time) as first_transaction,
        MAX(block_time) as last_transaction
      FROM transactions
      WHERE token_mint = $1`;
    
    const result = await this.pool.query(query, [tokenMint]);
    return result.rows[0];
  }

  /**
   * Get early buyers (bought in first X minutes)
   */
  async getEarlyBuyers(
    tokenMint: string,
    minutesAfterLaunch: number = 60
  ): Promise<string[]> {
    const query = `
      WITH first_trade AS (
        SELECT MIN(block_time) as launch_time
        FROM transactions
        WHERE token_mint = $1
      )
      SELECT DISTINCT signer as wallet
      FROM transactions t, first_trade ft
      WHERE t.token_mint = $1
        AND t.type = 'buy'
        AND t.block_time <= ft.launch_time + INTERVAL '${minutesAfterLaunch} minutes'
      ORDER BY t.block_time`;
    
    const result = await this.pool.query(query, [tokenMint]);
    return result.rows.map(row => row.wallet);
  }

  /**
   * Validate transaction data
   */
  validateTransaction(tx: TransactionData): boolean {
    // Check required fields
    if (!tx.signature || !tx.wallet || !tx.tokenMint) {
      return false;
    }
    
    // Check wallet address format (Solana address)
    if (!this.isValidSolanaAddress(tx.wallet)) {
      return false;
    }
    
    // Check token mint format
    if (!this.isValidSolanaAddress(tx.tokenMint)) {
      return false;
    }
    
    // Check amounts are positive
    if (tx.amount <= 0 || tx.solValue <= 0) {
      return false;
    }
    
    // Check transaction type
    if (tx.type !== 'buy' && tx.type !== 'sell') {
      return false;
    }
    
    return true;
  }

  private isValidSolanaAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  private normalizeTransactionType(type: string): 'buy' | 'sell' {
    const normalized = type?.toLowerCase();
    if (normalized === 'buy' || normalized === 'swap_in') return 'buy';
    if (normalized === 'sell' || normalized === 'swap_out') return 'sell';
    
    // Default to buy if uncertain
    return 'buy';
  }

  private mergeTransactions(
    transactions1: TransactionData[],
    transactions2: TransactionData[]
  ): TransactionData[] {
    const merged = new Map<string, TransactionData>();
    
    // Add all transactions, using signature as key to deduplicate
    for (const tx of [...transactions1, ...transactions2]) {
      if (!merged.has(tx.signature)) {
        merged.set(tx.signature, tx);
      }
    }
    
    // Sort by block time
    return Array.from(merged.values()).sort((a, b) => 
      new Date(b.blockTime).getTime() - new Date(a.blockTime).getTime()
    );
  }
}

export const transactionFetcher = new TransactionFetcher();