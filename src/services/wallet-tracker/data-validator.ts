import { PublicKey } from '@solana/web3.js';
import {
  DataValidationResult,
  GraduatedTokenData,
  TransactionData,
  WalletTrade,
  WalletTrader
} from './types';

export class DataValidator {
  
  /**
   * Validate graduated token data
   */
  validateGraduatedToken(token: GraduatedTokenData): DataValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Check mint address
    if (!this.isValidSolanaAddress(token.mint_address)) {
      errors.push(`Invalid mint address: ${token.mint_address}`);
    }
    
    // Check graduation timestamp
    const now = new Date();
    const graduationTime = new Date(token.graduation_timestamp);
    
    if (isNaN(graduationTime.getTime())) {
      errors.push('Invalid graduation timestamp');
    } else {
      if (graduationTime > now) {
        errors.push('Graduation timestamp is in the future');
      }
      
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      
      if (graduationTime < oneYearAgo) {
        warnings.push('Graduation timestamp is over 1 year old');
      }
    }
    
    // Check graduation signature
    if (!token.graduation_signature || token.graduation_signature.length < 88) {
      warnings.push('Missing or invalid graduation signature');
    }
    
    // Check price
    if (token.graduation_price < 0) {
      errors.push('Negative graduation price');
    } else if (token.graduation_price === 0) {
      warnings.push('Zero graduation price');
    }
    
    // Check market cap
    if (token.final_market_cap !== undefined) {
      if (token.final_market_cap < 0) {
        errors.push('Negative market cap');
      } else if (token.final_market_cap > 1000000000) { // > $1B
        warnings.push('Unusually high market cap');
      }
    }
    
    // Check migration platform
    const validPlatforms = ['raydium', 'meteora', 'other'];
    if (!validPlatforms.includes(token.migration_platform)) {
      errors.push(`Invalid migration platform: ${token.migration_platform}`);
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      data: errors.length === 0 ? token : undefined
    };
  }

  /**
   * Validate transaction data
   */
  validateTransaction(tx: TransactionData): DataValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Check signature
    if (!tx.signature || tx.signature.length < 88) {
      errors.push('Invalid transaction signature');
    }
    
    // Check wallet address
    if (!this.isValidSolanaAddress(tx.wallet)) {
      errors.push(`Invalid wallet address: ${tx.wallet}`);
    }
    
    // Check token mint
    if (!this.isValidSolanaAddress(tx.tokenMint)) {
      errors.push(`Invalid token mint: ${tx.tokenMint}`);
    }
    
    // Check block time
    const blockTime = new Date(tx.blockTime);
    if (isNaN(blockTime.getTime())) {
      errors.push('Invalid block time');
    } else {
      const now = new Date();
      if (blockTime > now) {
        errors.push('Block time is in the future');
      }
    }
    
    // Check transaction type
    if (tx.type !== 'buy' && tx.type !== 'sell') {
      errors.push(`Invalid transaction type: ${tx.type}`);
    }
    
    // Check amounts
    if (tx.amount <= 0) {
      errors.push('Non-positive token amount');
    }
    
    if (tx.solValue <= 0) {
      errors.push('Non-positive SOL value');
    }
    
    if (tx.price < 0) {
      errors.push('Negative price');
    } else if (tx.price === 0) {
      warnings.push('Zero price');
    }
    
    // Check for suspicious patterns
    if (tx.amount > 1e15) { // Extremely large amount
      warnings.push('Unusually large token amount');
    }
    
    if (tx.solValue > 10000) { // > 10,000 SOL
      warnings.push('Unusually large SOL value');
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      data: errors.length === 0 ? tx : undefined
    };
  }

  /**
   * Validate wallet trade
   */
  validateWalletTrade(trade: WalletTrade): DataValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Check wallet address
    if (!this.isValidSolanaAddress(trade.wallet_address)) {
      errors.push(`Invalid wallet address: ${trade.wallet_address}`);
    }
    
    // Check token mint
    if (!this.isValidSolanaAddress(trade.token_mint)) {
      errors.push(`Invalid token mint: ${trade.token_mint}`);
    }
    
    // Check trade type
    if (trade.trade_type !== 'buy' && trade.trade_type !== 'sell') {
      errors.push(`Invalid trade type: ${trade.trade_type}`);
    }
    
    // Check amounts
    if (trade.amount <= 0) {
      errors.push('Non-positive amount');
    }
    
    if (trade.price_sol <= 0) {
      errors.push('Non-positive price');
    }
    
    if (trade.sol_value <= 0) {
      errors.push('Non-positive SOL value');
    }
    
    // Check transaction hash
    if (!trade.transaction_hash || trade.transaction_hash.length < 88) {
      errors.push('Invalid transaction hash');
    }
    
    // Check block time
    const blockTime = new Date(trade.block_time);
    if (isNaN(blockTime.getTime())) {
      errors.push('Invalid block time');
    }
    
    // Check time to graduation
    if (trade.time_to_graduation_minutes !== undefined) {
      if (trade.time_to_graduation_minutes < 0) {
        warnings.push('Negative time to graduation (trade after graduation)');
      } else if (trade.time_to_graduation_minutes > 10080) { // > 1 week
        warnings.push('Trade occurred more than 1 week before graduation');
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      data: errors.length === 0 ? trade : undefined
    };
  }

  /**
   * Validate wallet profile
   */
  validateWalletProfile(wallet: WalletTrader): DataValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Check wallet address
    if (!this.isValidSolanaAddress(wallet.wallet_address)) {
      errors.push(`Invalid wallet address: ${wallet.wallet_address}`);
    }
    
    // Check wallet type
    const validTypes = ['normal', 'bot', 'dev', 'whale', 'sybil', 'influencer'];
    if (!validTypes.includes(wallet.wallet_type)) {
      errors.push(`Invalid wallet type: ${wallet.wallet_type}`);
    }
    
    // Check scores and percentages
    if (wallet.reputation_score < 0 || wallet.reputation_score > 100) {
      errors.push('Reputation score out of range (0-100)');
    }
    
    if (wallet.trader_score < 0 || wallet.trader_score > 1000) {
      errors.push('Trader score out of range (0-1000)');
    }
    
    if (wallet.win_rate < 0 || wallet.win_rate > 100) {
      errors.push('Win rate out of range (0-100)');
    }
    
    if (wallet.score_decay_factor < 0 || wallet.score_decay_factor > 1) {
      errors.push('Score decay factor out of range (0-1)');
    }
    
    if (wallet.cluster_confidence !== undefined && wallet.cluster_confidence !== null) {
      if (wallet.cluster_confidence < 0 || wallet.cluster_confidence > 1) {
        errors.push('Cluster confidence out of range (0-1)');
      }
    }
    
    // Check counts
    if (wallet.total_trades < 0) {
      errors.push('Negative total trades');
    }
    
    if (wallet.graduated_tokens_traded < 0) {
      errors.push('Negative graduated tokens count');
    }
    
    if (wallet.days_inactive < 0) {
      errors.push('Negative days inactive');
    }
    
    if (wallet.suspicious_activity_count < 0) {
      errors.push('Negative suspicious activity count');
    }
    
    // Check dates
    const firstSeen = new Date(wallet.first_seen_at);
    const lastActivity = new Date(wallet.last_activity_at);
    
    if (isNaN(firstSeen.getTime())) {
      errors.push('Invalid first seen date');
    }
    
    if (isNaN(lastActivity.getTime())) {
      errors.push('Invalid last activity date');
    }
    
    if (firstSeen > lastActivity) {
      errors.push('First seen date is after last activity date');
    }
    
    // Warnings for suspicious patterns
    if (wallet.trader_score > 900) {
      warnings.push('Very high trader score - verify authenticity');
    }
    
    if (wallet.win_rate > 90 && wallet.total_trades > 50) {
      warnings.push('Unusually high win rate for high trade count');
    }
    
    if (wallet.avg_return_multiple > 100) {
      warnings.push('Extremely high return multiple - possible data error');
    }
    
    if (wallet.suspicious_activity_count > 5) {
      warnings.push('High suspicious activity count');
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      data: errors.length === 0 ? wallet : undefined
    };
  }

  /**
   * Validate batch of data
   */
  validateBatch<T>(
    items: T[],
    validator: (item: T) => DataValidationResult
  ): {
    valid: T[];
    invalid: Array<{ item: T; errors: string[] }>;
    warnings: Array<{ item: T; warnings: string[] }>;
  } {
    const valid: T[] = [];
    const invalid: Array<{ item: T; errors: string[] }> = [];
    const warnings: Array<{ item: T; warnings: string[] }> = [];
    
    for (const item of items) {
      const result = validator.call(this, item);
      
      if (result.isValid) {
        valid.push(item);
        
        if (result.warnings.length > 0) {
          warnings.push({ item, warnings: result.warnings });
        }
      } else {
        invalid.push({ item, errors: result.errors });
      }
    }
    
    return { valid, invalid, warnings };
  }

  /**
   * Check if address is valid Solana address
   */
  private isValidSolanaAddress(address: string): boolean {
    if (!address || typeof address !== 'string') {
      return false;
    }
    
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate data consistency across related entities
   */
  async validateDataConsistency(
    wallet: WalletTrader,
    trades: WalletTrade[]
  ): Promise<DataValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Check trade count consistency
    if (wallet.total_trades !== trades.length) {
      warnings.push(`Trade count mismatch: wallet shows ${wallet.total_trades}, found ${trades.length}`);
    }
    
    // Calculate metrics from trades and compare
    let totalPnL = 0;
    let winCount = 0;
    const uniqueTokens = new Set<string>();
    
    for (const trade of trades) {
      uniqueTokens.add(trade.token_mint);
      
      // Simple PnL calculation (would need more complex logic in production)
      if (trade.trade_type === 'sell') {
        // This is simplified - actual PnL calculation would be more complex
        totalPnL += trade.sol_value;
      } else {
        totalPnL -= trade.sol_value;
      }
    }
    
    // Check if calculated values are reasonably close to stored values
    const pnlDifference = Math.abs(wallet.total_pnl_sol - totalPnL);
    if (pnlDifference > 10) { // Allow 10 SOL difference
      warnings.push(`PnL inconsistency: stored ${wallet.total_pnl_sol}, calculated ${totalPnL}`);
    }
    
    // Check graduated tokens count
    const graduatedCount = trades.filter(t => t.is_graduated_token).length;
    if (graduatedCount > 0 && wallet.graduated_tokens_traded === 0) {
      warnings.push('Wallet shows no graduated tokens but trades indicate otherwise');
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Generate validation report
   */
  generateValidationReport(results: {
    tokens: DataValidationResult[];
    transactions: DataValidationResult[];
    wallets: DataValidationResult[];
  }): string {
    let report = '=== Data Validation Report ===\n\n';
    
    // Token validation summary
    const validTokens = results.tokens.filter(r => r.isValid).length;
    const totalTokens = results.tokens.length;
    report += `Tokens: ${validTokens}/${totalTokens} valid (${((validTokens/totalTokens)*100).toFixed(1)}%)\n`;
    
    // Transaction validation summary  
    const validTxs = results.transactions.filter(r => r.isValid).length;
    const totalTxs = results.transactions.length;
    report += `Transactions: ${validTxs}/${totalTxs} valid (${((validTxs/totalTxs)*100).toFixed(1)}%)\n`;
    
    // Wallet validation summary
    const validWallets = results.wallets.filter(r => r.isValid).length;
    const totalWallets = results.wallets.length;
    report += `Wallets: ${validWallets}/${totalWallets} valid (${((validWallets/totalWallets)*100).toFixed(1)}%)\n`;
    
    // Common errors
    report += '\n=== Common Errors ===\n';
    const allErrors = [
      ...results.tokens.flatMap(r => r.errors),
      ...results.transactions.flatMap(r => r.errors),
      ...results.wallets.flatMap(r => r.errors)
    ];
    
    const errorCounts = new Map<string, number>();
    for (const error of allErrors) {
      const key = error.split(':')[0]; // Get error type
      errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
    }
    
    const sortedErrors = Array.from(errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    for (const [error, count] of sortedErrors) {
      report += `  ${error}: ${count} occurrences\n`;
    }
    
    // Common warnings
    report += '\n=== Common Warnings ===\n';
    const allWarnings = [
      ...results.tokens.flatMap(r => r.warnings),
      ...results.transactions.flatMap(r => r.warnings),
      ...results.wallets.flatMap(r => r.warnings)
    ];
    
    const warningCounts = new Map<string, number>();
    for (const warning of allWarnings) {
      const key = warning.split(':')[0];
      warningCounts.set(key, (warningCounts.get(key) || 0) + 1);
    }
    
    const sortedWarnings = Array.from(warningCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    for (const [warning, count] of sortedWarnings) {
      report += `  ${warning}: ${count} occurrences\n`;
    }
    
    return report;
  }
}

export const dataValidator = new DataValidator();