import { BaseOperations } from '../base-operations';
import { Transaction } from '../types';

// Re-export Transaction type for backward compatibility
export type { Transaction };

export class TransactionOperations extends BaseOperations {
  constructor() {
    super();
  }

  /**
   * Insert a single transaction
   */
  async insertTransaction(transaction: Transaction): Promise<void> {
    const query = `
      INSERT INTO transactions (
        signature, pool_id, token_id, block_time, slot, type, user_address,
        amount_in, amount_in_decimals, amount_out, amount_out_decimals,
        sol_amount, token_amount, price_per_token,
        protocol_fee, platform_fee, transaction_fee,
        success, raw_data
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      )
      ON CONFLICT (signature, block_time) DO NOTHING
    `;

    const values = [
      transaction.signature,
      transaction.pool_id,
      transaction.token_id,
      transaction.block_time,
      transaction.slot,
      transaction.type,
      transaction.user_address,
      transaction.amount_in,
      transaction.amount_in_decimals,
      transaction.amount_out,
      transaction.amount_out_decimals,
      transaction.sol_amount || null,
      transaction.token_amount || null,
      transaction.price_per_token || null,
      transaction.protocol_fee || null,
      transaction.platform_fee || null,
      transaction.transaction_fee || null,
      transaction.success !== undefined ? transaction.success : true,
      transaction.raw_data || null
    ];

    await this.execute(query, values);
  }

  /**
   * Create single transaction (new simplified interface)
   */
  async create(transaction: Transaction): Promise<void> {
    // Map to existing database columns
    const query = `
      INSERT INTO transactions (
        signature, pool_id, token_id, block_time, slot, type,
        user_address, amount_in, amount_in_decimals, amount_out, amount_out_decimals,
        sol_amount, token_amount, price_per_token,
        protocol_fee, platform_fee, transaction_fee,
        success, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (signature, block_time) DO NOTHING
    `;

    // Determine amount_in/out based on transaction type
    let amountIn, amountOut, amountInDecimals, amountOutDecimals;
    const solAmount = parseFloat(transaction.sol_amount);
    const tokenAmount = parseFloat(transaction.token_amount);
    
    if (transaction.type === 'buy') {
      amountIn = transaction.sol_amount;
      amountInDecimals = 9; // SOL decimals
      amountOut = transaction.token_amount;
      amountOutDecimals = 6; // Default token decimals
    } else {
      amountIn = transaction.token_amount;
      amountInDecimals = 6; // Default token decimals
      amountOut = transaction.sol_amount;
      amountOutDecimals = 9; // SOL decimals
    }

    const values = [
      transaction.signature,
      transaction.pool_id,
      transaction.token_id,
      transaction.block_time,
      transaction.slot,
      transaction.type,
      transaction.user_address,
      amountIn,
      amountInDecimals,
      amountOut,
      amountOutDecimals,
      solAmount || null,
      tokenAmount || null,
      transaction.price_per_token || null,
      transaction.protocol_fee || null,
      transaction.platform_fee || null,
      transaction.transaction_fee || null,
      transaction.success !== undefined ? transaction.success : true,
      transaction.raw_data || transaction.metadata || null
    ];

    await this.execute(query, values);
  }

  /**
   * Create batch of transactions (simplified interface for MonitorService)
   */
  async createBatch(transactions: Transaction[]): Promise<void> {
    if (transactions.length === 0) return;

    // PostgreSQL has a limit of ~65,535 parameters per query
    // With 17 fields per transaction, we can safely do ~3000 at a time
    const BATCH_SIZE = 1000;

    // Process in chunks if needed
    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
      const batch = transactions.slice(i, i + BATCH_SIZE);
      await this._insertBatchSimple(batch);
    }
  }

  /**
   * Bulk insert transactions efficiently (legacy interface)
   */
  async bulkInsertTransactions(transactions: Transaction[]): Promise<number> {
    if (transactions.length === 0) return 0;

    // PostgreSQL has a limit of ~65,535 parameters per query
    // With 19 fields per transaction, we can safely do ~3000 at a time
    const BATCH_SIZE = 2000;
    let totalInserted = 0;

    // Process in chunks if needed
    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
      const batch = transactions.slice(i, i + BATCH_SIZE);
      const inserted = await this._insertBatch(batch);
      totalInserted += inserted;
    }

    return totalInserted;
  }

  private async _insertBatchSimple(transactions: Transaction[]): Promise<void> {
    const values: any[] = [];
    const placeholders: string[] = [];
    
    transactions.forEach((tx, index) => {
      const offset = index * 19; // 19 fields per transaction (same as legacy)
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, 
          $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, 
          $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15},
          $${offset + 16}, $${offset + 17}, $${offset + 18}, $${offset + 19})`
      );
      
      // Determine amount_in/out based on transaction type
      const solAmount = parseFloat(tx.sol_amount);
      const tokenAmount = parseFloat(tx.token_amount);
      let amountIn, amountOut, amountInDecimals, amountOutDecimals;
      
      if (tx.type === 'buy') {
        amountIn = tx.sol_amount;
        amountInDecimals = 9;
        amountOut = tx.token_amount;
        amountOutDecimals = 6;
      } else {
        amountIn = tx.token_amount;
        amountInDecimals = 6;
        amountOut = tx.sol_amount;
        amountOutDecimals = 9;
      }
      
      values.push(
        tx.signature,
        tx.pool_id,
        tx.token_id,
        tx.block_time,
        tx.slot,
        tx.type,
        tx.user_address,
        amountIn,
        amountInDecimals,
        amountOut,
        amountOutDecimals,
        solAmount || null,
        tokenAmount || null,
        tx.price_per_token || null,
        tx.protocol_fee || null,
        tx.platform_fee || null,
        tx.transaction_fee || null,
        tx.success !== undefined ? tx.success : true,
        tx.raw_data || tx.metadata || null
      );
    });

    const query = `
      INSERT INTO transactions (
        signature, pool_id, token_id, block_time, slot, type, user_address,
        amount_in, amount_in_decimals, amount_out, amount_out_decimals,
        sol_amount, token_amount, price_per_token,
        protocol_fee, platform_fee, transaction_fee,
        success, raw_data
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (signature, block_time) DO NOTHING
    `;

    await this.query(query, values);
  }

  private async _insertBatch(transactions: Transaction[]): Promise<number> {
    return this.executeInTransaction(async (client) => {
      // Build the VALUES clause for bulk insert
      const values: any[] = [];
      const placeholders: string[] = [];
      
      transactions.forEach((tx, index) => {
        const offset = index * 19; // 19 fields per transaction
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, 
            $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, 
            $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15},
            $${offset + 16}, $${offset + 17}, $${offset + 18}, $${offset + 19})`
        );
        
        values.push(
          tx.signature,
          tx.pool_id,
          tx.token_id,
          tx.block_time,
          tx.slot,
          tx.type,
          tx.user_address,
          tx.amount_in,
          tx.amount_in_decimals,
          tx.amount_out,
          tx.amount_out_decimals,
          tx.sol_amount || null,
          tx.token_amount || null,
          tx.price_per_token || null,
          tx.protocol_fee || null,
          tx.platform_fee || null,
          tx.transaction_fee || null,
          tx.success !== undefined ? tx.success : true,
          tx.raw_data || null
        );
      });

      const query = `
        INSERT INTO transactions (
          signature, pool_id, token_id, block_time, slot, type, user_address,
          amount_in, amount_in_decimals, amount_out, amount_out_decimals,
          sol_amount, token_amount, price_per_token,
          protocol_fee, platform_fee, transaction_fee,
          success, raw_data
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (signature, block_time) DO NOTHING
      `;

      const result = await client.query(query, values);
      return result.rowCount || 0;
    });
  }

  /**
   * Get recent transactions for a token
   */
  async getRecentTransactions(tokenId: string, limit: number = 100): Promise<any[]> {
    const query = `
      SELECT 
        t.*,
        tok.symbol,
        tok.name,
        p.platform
      FROM transactions t
      JOIN tokens tok ON t.token_id = tok.id
      JOIN pools p ON t.pool_id = p.id
      WHERE t.token_id = $1
      ORDER BY t.block_time DESC
      LIMIT $2
    `;

    return await this.queryMany(query, [tokenId, limit]);
  }

  /**
   * Get transaction volume statistics
   */
  async getVolumeStats(tokenId: string, intervalHours: number = 24): Promise<any> {
    const query = `
      SELECT * FROM get_transaction_volume_stats($1, $2::interval)
    `;

    return await this.queryOne(query, [tokenId, `${intervalHours} hours`]);
  }

  /**
   * Get transaction count by type
   */
  async getTransactionCountByType(tokenId: string, intervalHours: number = 24): Promise<any[]> {
    const query = `
      SELECT 
        type,
        COUNT(*) as count,
        SUM(sol_amount) as total_sol_volume,
        AVG(sol_amount) as avg_sol_amount,
        COUNT(DISTINCT user_address) as unique_users
      FROM transactions
      WHERE token_id = $1
        AND block_time > NOW() - INTERVAL '${intervalHours} hours'
      GROUP BY type
      ORDER BY count DESC
    `;

    return await this.queryMany(query, [tokenId]);
  }

  /**
   * Check hypertable health and chunk information
   */
  async getHypertableInfo(): Promise<any> {
    // Different TimescaleDB versions have different views, so we'll try multiple approaches
    try {
      // Try newer TimescaleDB format first
      const query = `
        SELECT 
          hypertable_name,
          hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass) as total_size,
          pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass)) as total_size_pretty,
          (SELECT count(*) FROM show_chunks(format('%I.%I', hypertable_schema, hypertable_name)::regclass)) as num_chunks
        FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'transactions'
      `;
      
      const result = await this.queryOne(query);
      if (result) {
        return result;
      }
    } catch (e) {
      // Fall back to basic query
      const fallbackQuery = `
        SELECT 
          'transactions' as hypertable_name,
          pg_size_pretty(pg_total_relation_size('transactions')) as total_size_pretty,
          (SELECT count(*) FROM pg_inherits WHERE inhparent = 'transactions'::regclass) as num_chunks
      `;
      
      return await this.queryOne(fallbackQuery);
    }
  }

  /**
   * Get chunk statistics for performance monitoring
   */
  async getChunkStats(): Promise<any[]> {
    try {
      // Try to get chunk information
      const query = `
        SELECT 
          chunk_schema || '.' || chunk_name as chunk_name,
          pg_size_pretty(pg_total_relation_size(format('%I.%I', chunk_schema, chunk_name)::regclass)) as chunk_size
        FROM timescaledb_information.chunks
        WHERE hypertable_name = 'transactions'
        ORDER BY chunk_name DESC
        LIMIT 10
      `;

      return await this.queryMany(query);
    } catch (e) {
      // Fallback for different TimescaleDB versions
      return [{
        chunk_name: 'Chunk information not available',
        chunk_size: 'N/A'
      }];
    }
  }
}

// Export singleton instance
export const transactionOperations = new TransactionOperations();