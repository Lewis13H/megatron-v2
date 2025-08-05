/**
 * @deprecated This file is being replaced by MonitorService (monitor-service.ts)
 * Monitors should use: import { monitorService } from '../../database';
 * Use monitorService.saveTransaction() or monitorService.saveTransactionBatch()
 * This file will be removed after all monitors are migrated.
 */
import { TransactionOperations, Transaction } from './operations/transaction';
import { getDbPool } from './connection';

export interface MonitorTransaction {
  signature: string;
  type: 'buy' | 'sell' | 'add_liquidity' | 'remove_liquidity';
  user: string;
  mint: string;
  bondingCurve?: string;
  poolAddress?: string;
  solAmount: number;
  tokenAmount: number;
  timestamp: string;
  slot?: number;
  amountIn?: string;
  amountInDecimals?: number;
  amountOut?: string;
  amountOutDecimals?: number;
  protocolFee?: string;
  platformFee?: string;
  transactionFee?: number;
  success?: boolean;
  rawData?: any;
}

export class TransactionMonitorIntegration {
  private txOps: TransactionOperations;
  private pool: any;
  private tokenCache: Map<string, { tokenId: string; poolId: string }> = new Map();

  constructor() {
    this.txOps = new TransactionOperations();
    this.pool = getDbPool();
  }

  /**
   * Get or create token and pool IDs from mint address
   */
  private async getTokenAndPoolIds(
    mintAddress: string, 
    poolAddress?: string,
    bondingCurve?: string
  ): Promise<{ tokenId: string; poolId: string } | null> {
    // Check cache first
    const cached = this.tokenCache.get(mintAddress);
    if (cached) {
      return cached;
    }

    try {
      // Look up token
      const tokenResult = await this.pool.query(
        'SELECT id FROM tokens WHERE mint_address = $1',
        [mintAddress]
      );

      if (tokenResult.rows.length === 0) {
        console.warn(`Token not found for mint: ${mintAddress}`);
        return null;
      }

      const tokenId = tokenResult.rows[0].id;

      // Look up pool - try pool address first, then bonding curve
      let poolQuery = 'SELECT id FROM pools WHERE token_id = $1';
      let poolParams = [tokenId];

      if (poolAddress) {
        poolQuery += ' AND pool_address = $2';
        poolParams.push(poolAddress);
      } else if (bondingCurve) {
        poolQuery += ' AND bonding_curve_address = $2';
        poolParams.push(bondingCurve);
      }

      const poolResult = await this.pool.query(poolQuery, poolParams);

      if (poolResult.rows.length === 0) {
        console.warn(`Pool not found for token: ${mintAddress}`);
        return null;
      }

      const poolId = poolResult.rows[0].id;
      
      // Cache the result
      const result = { tokenId, poolId };
      this.tokenCache.set(mintAddress, result);
      
      return result;
    } catch (error) {
      console.error('Error looking up token/pool:', error);
      return null;
    }
  }

  /**
   * Convert monitor transaction to database format
   */
  private convertToDbTransaction(
    monitorTx: MonitorTransaction,
    tokenId: string,
    poolId: string
  ): Transaction {
    // For buy/sell transactions, determine amounts based on type
    let amountIn = monitorTx.amountIn || '0';
    let amountInDecimals = monitorTx.amountInDecimals || 9;
    let amountOut = monitorTx.amountOut || '0';
    let amountOutDecimals = monitorTx.amountOutDecimals || 6;

    // If not provided, calculate from sol/token amounts
    if (!monitorTx.amountIn || !monitorTx.amountOut) {
      if (monitorTx.type === 'buy') {
        amountIn = (monitorTx.solAmount * 1e9).toString();
        amountInDecimals = 9;
        amountOut = (monitorTx.tokenAmount * 1e6).toString();
        amountOutDecimals = 6;
      } else if (monitorTx.type === 'sell') {
        amountIn = (monitorTx.tokenAmount * 1e6).toString();
        amountInDecimals = 6;
        amountOut = (monitorTx.solAmount * 1e9).toString();
        amountOutDecimals = 9;
      }
    }

    return {
      signature: monitorTx.signature,
      pool_id: poolId,
      token_id: tokenId,
      block_time: new Date(monitorTx.timestamp),
      slot: monitorTx.slot || 0,
      type: monitorTx.type,
      user_address: monitorTx.user,
      amount_in: amountIn,
      amount_in_decimals: amountInDecimals,
      amount_out: amountOut,
      amount_out_decimals: amountOutDecimals,
      sol_amount: monitorTx.solAmount,
      token_amount: monitorTx.tokenAmount,
      price_per_token: monitorTx.tokenAmount > 0 ? monitorTx.solAmount / monitorTx.tokenAmount : 0,
      protocol_fee: monitorTx.protocolFee,
      platform_fee: monitorTx.platformFee,
      transaction_fee: monitorTx.transactionFee,
      success: monitorTx.success !== false,
      raw_data: monitorTx.rawData
    };
  }

  /**
   * Save a single transaction from monitor
   */
  async saveTransaction(monitorTx: MonitorTransaction): Promise<boolean> {
    const ids = await this.getTokenAndPoolIds(
      monitorTx.mint,
      monitorTx.poolAddress,
      monitorTx.bondingCurve
    );

    if (!ids) {
      return false;
    }

    try {
      const dbTx = this.convertToDbTransaction(monitorTx, ids.tokenId, ids.poolId);
      await this.txOps.insertTransaction(dbTx);
      return true;
    } catch (error: any) {
      if (error.code === '23505') {
        // Duplicate key - transaction already exists
        console.debug(`Transaction already exists: ${monitorTx.signature}`);
        return true;
      }
      console.error('Error saving transaction:', error);
      return false;
    }
  }

  /**
   * Save multiple transactions from monitor
   */
  async saveTransactions(monitorTxs: MonitorTransaction[]): Promise<number> {
    if (monitorTxs.length === 0) return 0;

    const dbTransactions: Transaction[] = [];
    const skipped: string[] = [];

    // Convert all transactions
    for (const monitorTx of monitorTxs) {
      const ids = await this.getTokenAndPoolIds(
        monitorTx.mint,
        monitorTx.poolAddress,
        monitorTx.bondingCurve
      );

      if (!ids) {
        skipped.push(monitorTx.signature);
        continue;
      }

      dbTransactions.push(
        this.convertToDbTransaction(monitorTx, ids.tokenId, ids.poolId)
      );
    }

    if (skipped.length > 0) {
      console.warn(`Skipped ${skipped.length} transactions (token/pool not found)`);
    }

    if (dbTransactions.length === 0) {
      return 0;
    }

    try {
      const inserted = await this.txOps.bulkInsertTransactions(dbTransactions);
      console.log(`Saved ${inserted} transactions to database`);
      return inserted;
    } catch (error) {
      console.error('Error in bulk transaction save:', error);
      return 0;
    }
  }

  /**
   * Clear the token cache (useful if new tokens are added)
   */
  clearCache() {
    this.tokenCache.clear();
  }
}

// Singleton instance
let integrationInstance: TransactionMonitorIntegration | null = null;

export function getTransactionIntegration(): TransactionMonitorIntegration {
  if (!integrationInstance) {
    integrationInstance = new TransactionMonitorIntegration();
  }
  return integrationInstance;
}