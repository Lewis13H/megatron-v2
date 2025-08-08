import { Pool } from 'pg';
import { DatabaseConnection } from '../../database/connection';
import {
  WalletTrader,
  WalletTrade,
  WalletPosition,
  WalletScoreHistory,
  TokenSmartMoneySignal,
  GraduatedTokenData,
  TransactionData,
  WalletMetrics,
  PnLCalculation,
  WalletClassification,
  ScoreComponents,
  TopTrader
} from './types';

export class WalletTrackerService {
  private pool: Pool;
  private readonly MIN_TRADER_SCORE = 700; // Minimum score to be considered "smart money"
  private readonly SCORE_DECAY_DAYS = 7; // Days before score starts decaying
  
  constructor() {
    this.pool = DatabaseConnection.getPool();
  }

  // ============ Wallet Management ============

  async createOrUpdateWallet(wallet: Partial<WalletTrader>): Promise<WalletTrader> {
    const query = `
      INSERT INTO wallet_traders (
        wallet_address, wallet_type, cluster_id, cluster_confidence,
        reputation_score, first_seen_at, last_activity_at, total_trades,
        graduated_tokens_traded, total_pnl_sol, total_pnl_usd, win_rate,
        avg_hold_time_minutes, avg_return_multiple, trader_score,
        score_updated_at, score_decay_factor, days_inactive,
        suspicious_activity_count, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      ON CONFLICT (wallet_address) DO UPDATE SET
        wallet_type = EXCLUDED.wallet_type,
        cluster_id = EXCLUDED.cluster_id,
        cluster_confidence = EXCLUDED.cluster_confidence,
        reputation_score = EXCLUDED.reputation_score,
        last_activity_at = EXCLUDED.last_activity_at,
        total_trades = EXCLUDED.total_trades,
        graduated_tokens_traded = EXCLUDED.graduated_tokens_traded,
        total_pnl_sol = EXCLUDED.total_pnl_sol,
        total_pnl_usd = EXCLUDED.total_pnl_usd,
        win_rate = EXCLUDED.win_rate,
        avg_hold_time_minutes = EXCLUDED.avg_hold_time_minutes,
        avg_return_multiple = EXCLUDED.avg_return_multiple,
        trader_score = EXCLUDED.trader_score,
        score_updated_at = EXCLUDED.score_updated_at,
        score_decay_factor = EXCLUDED.score_decay_factor,
        days_inactive = EXCLUDED.days_inactive,
        suspicious_activity_count = EXCLUDED.suspicious_activity_count,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *`;

    const values = [
      wallet.wallet_address,
      wallet.wallet_type || 'normal',
      wallet.cluster_id || null,
      wallet.cluster_confidence || null,
      wallet.reputation_score || 50,
      wallet.first_seen_at || new Date(),
      wallet.last_activity_at || new Date(),
      wallet.total_trades || 0,
      wallet.graduated_tokens_traded || 0,
      wallet.total_pnl_sol || 0,
      wallet.total_pnl_usd || 0,
      wallet.win_rate || 0,
      wallet.avg_hold_time_minutes || 0,
      wallet.avg_return_multiple || 0,
      wallet.trader_score || 0,
      wallet.score_updated_at || null,
      wallet.score_decay_factor || 1.0,
      wallet.days_inactive || 0,
      wallet.suspicious_activity_count || 0,
      wallet.metadata || {}
    ];

    const result = await this.pool.query(query, values);
    return result.rows[0];
  }

  async getWallet(walletAddress: string): Promise<WalletTrader | null> {
    const query = 'SELECT * FROM wallet_traders WHERE wallet_address = $1';
    const result = await this.pool.query(query, [walletAddress]);
    return result.rows[0] || null;
  }

  async getTopWallets(limit: number = 100): Promise<WalletTrader[]> {
    const query = `
      SELECT * FROM wallet_traders 
      WHERE trader_score > 0
      ORDER BY trader_score DESC 
      LIMIT $1`;
    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  async getSmartMoneyWallets(minScore: number = 700): Promise<WalletTrader[]> {
    const query = `
      SELECT * FROM wallet_traders 
      WHERE trader_score >= $1 
        AND wallet_type != 'bot'
        AND wallet_type != 'sybil'
      ORDER BY trader_score DESC`;
    const result = await this.pool.query(query, [minScore]);
    return result.rows;
  }

  // ============ Trade Management ============

  async saveTrade(trade: WalletTrade): Promise<void> {
    const query = `
      INSERT INTO wallet_trades (
        wallet_address, token_mint, trade_type, amount, price_sol,
        price_usd, sol_value, transaction_hash, block_time,
        is_graduated_token, time_to_graduation_minutes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

    const values = [
      trade.wallet_address,
      trade.token_mint,
      trade.trade_type,
      trade.amount,
      trade.price_sol,
      trade.price_usd || null,
      trade.sol_value,
      trade.transaction_hash,
      trade.block_time,
      trade.is_graduated_token,
      trade.time_to_graduation_minutes || null
    ];

    await this.pool.query(query, values);
  }

  async saveTradeBatch(trades: WalletTrade[]): Promise<void> {
    if (trades.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const trade of trades) {
        await this.saveTrade(trade);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getWalletTrades(walletAddress: string, tokenMint?: string): Promise<WalletTrade[]> {
    let query = 'SELECT * FROM wallet_trades WHERE wallet_address = $1';
    const values: any[] = [walletAddress];

    if (tokenMint) {
      query += ' AND token_mint = $2';
      values.push(tokenMint);
    }

    query += ' ORDER BY block_time DESC';

    const result = await this.pool.query(query, values);
    return result.rows;
  }

  // ============ Position Management ============

  async updatePosition(position: WalletPosition): Promise<void> {
    const query = `
      INSERT INTO wallet_positions (
        wallet_address, token_mint, total_bought, total_sold,
        current_balance, avg_buy_price, avg_sell_price,
        realized_pnl_sol, unrealized_pnl_sol, first_buy_at,
        last_sell_at, is_graduated, graduation_entry_timing,
        position_score
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (wallet_address, token_mint) DO UPDATE SET
        total_bought = EXCLUDED.total_bought,
        total_sold = EXCLUDED.total_sold,
        current_balance = EXCLUDED.current_balance,
        avg_buy_price = EXCLUDED.avg_buy_price,
        avg_sell_price = EXCLUDED.avg_sell_price,
        realized_pnl_sol = EXCLUDED.realized_pnl_sol,
        unrealized_pnl_sol = EXCLUDED.unrealized_pnl_sol,
        last_sell_at = EXCLUDED.last_sell_at,
        is_graduated = EXCLUDED.is_graduated,
        graduation_entry_timing = EXCLUDED.graduation_entry_timing,
        position_score = EXCLUDED.position_score,
        updated_at = NOW()`;

    const values = [
      position.wallet_address,
      position.token_mint,
      position.total_bought,
      position.total_sold,
      position.current_balance,
      position.avg_buy_price || null,
      position.avg_sell_price || null,
      position.realized_pnl_sol,
      position.unrealized_pnl_sol,
      position.first_buy_at || null,
      position.last_sell_at || null,
      position.is_graduated,
      position.graduation_entry_timing || null,
      position.position_score
    ];

    await this.pool.query(query, values);
  }

  async getWalletPosition(walletAddress: string, tokenMint: string): Promise<WalletPosition | null> {
    const query = `
      SELECT * FROM wallet_positions 
      WHERE wallet_address = $1 AND token_mint = $2`;
    const result = await this.pool.query(query, [walletAddress, tokenMint]);
    return result.rows[0] || null;
  }

  async getWalletPositions(walletAddress: string): Promise<WalletPosition[]> {
    const query = `
      SELECT * FROM wallet_positions 
      WHERE wallet_address = $1 
      ORDER BY total_pnl_sol DESC`;
    const result = await this.pool.query(query, [walletAddress]);
    return result.rows;
  }

  // ============ Score Management ============

  async saveScoreHistory(score: WalletScoreHistory): Promise<void> {
    const query = `
      INSERT INTO wallet_scores_history (
        wallet_address, score_timestamp, trader_score, components,
        graduated_tokens_count, total_pnl_sol, win_rate,
        avg_multiplier, consistency_score, timing_score
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

    const values = [
      score.wallet_address,
      score.score_timestamp,
      score.trader_score,
      JSON.stringify(score.components),
      score.graduated_tokens_count || null,
      score.total_pnl_sol || null,
      score.win_rate || null,
      score.avg_multiplier || null,
      score.consistency_score || null,
      score.timing_score || null
    ];

    await this.pool.query(query, values);
  }

  async getLatestScore(walletAddress: string): Promise<WalletScoreHistory | null> {
    const query = `
      SELECT * FROM wallet_scores_history 
      WHERE wallet_address = $1 
      ORDER BY score_timestamp DESC 
      LIMIT 1`;
    const result = await this.pool.query(query, [walletAddress]);
    
    if (result.rows[0]) {
      result.rows[0].components = 
        typeof result.rows[0].components === 'string' 
          ? JSON.parse(result.rows[0].components)
          : result.rows[0].components;
    }
    
    return result.rows[0] || null;
  }

  // ============ Smart Money Signals ============

  async saveSmartMoneySignal(signal: TokenSmartMoneySignal): Promise<void> {
    const query = `
      INSERT INTO token_smart_money_signals (
        token_mint, signal_timestamp, smart_wallets_count,
        avg_trader_score, total_smart_money_invested_sol,
        top_traders, signal_strength
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`;

    const values = [
      signal.token_mint,
      signal.signal_timestamp,
      signal.smart_wallets_count,
      signal.avg_trader_score || null,
      signal.total_smart_money_invested_sol || null,
      JSON.stringify(signal.top_traders || []),
      signal.signal_strength || null
    ];

    await this.pool.query(query, values);
  }

  async getTokenSmartMoneySignals(tokenMint: string, limit: number = 10): Promise<TokenSmartMoneySignal[]> {
    const query = `
      SELECT * FROM token_smart_money_signals 
      WHERE token_mint = $1 
      ORDER BY signal_timestamp DESC 
      LIMIT $2`;
    const result = await this.pool.query(query, [tokenMint, limit]);
    
    return result.rows.map(row => ({
      ...row,
      top_traders: typeof row.top_traders === 'string' 
        ? JSON.parse(row.top_traders) 
        : row.top_traders
    }));
  }

  async getLatestSmartMoneySignal(tokenMint: string): Promise<TokenSmartMoneySignal | null> {
    const signals = await this.getTokenSmartMoneySignals(tokenMint, 1);
    return signals[0] || null;
  }

  // ============ Graduated Tokens ============

  async getGraduatedTokens(limit: number = 100): Promise<any[]> {
    const query = `
      SELECT DISTINCT 
        gt.token_mint,
        gt.graduation_timestamp,
        gt.graduation_signature,
        gt.migration_type,
        t.symbol,
        t.name,
        t.image_url
      FROM graduated_tokens gt
      LEFT JOIN tokens t ON gt.token_mint = t.mint_address
      WHERE gt.graduation_timestamp IS NOT NULL
      ORDER BY gt.graduation_timestamp DESC
      LIMIT $1`;
    
    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  async isTokenGraduated(tokenMint: string): Promise<boolean> {
    const query = `
      SELECT 1 FROM graduated_tokens 
      WHERE token_mint = $1 
      LIMIT 1`;
    const result = await this.pool.query(query, [tokenMint]);
    return result.rows.length > 0;
  }

  // ============ PnL Calculation ============

  async calculateWalletPnL(walletAddress: string, tokenMint: string): Promise<PnLCalculation> {
    const trades = await this.getWalletTrades(walletAddress, tokenMint);
    
    let totalBought = 0;
    let totalSold = 0;
    let totalBoughtValue = 0;
    let totalSoldValue = 0;

    for (const trade of trades) {
      if (trade.trade_type === 'buy') {
        totalBought += trade.amount;
        totalBoughtValue += trade.sol_value;
      } else {
        totalSold += trade.amount;
        totalSoldValue += trade.sol_value;
      }
    }

    const currentBalance = totalBought - totalSold;
    const avgBuyPrice = totalBought > 0 ? totalBoughtValue / totalBought : 0;
    const avgSellPrice = totalSold > 0 ? totalSoldValue / totalSold : 0;
    const realizedPnL = totalSoldValue - (avgBuyPrice * totalSold);
    
    // For unrealized PnL, we'd need current price
    // This is a placeholder - actual implementation would fetch current price
    const unrealizedPnL = 0;

    return {
      wallet_address: walletAddress,
      token_mint: tokenMint,
      realized_pnl: realizedPnL,
      unrealized_pnl: unrealizedPnL,
      total_pnl: realizedPnL + unrealizedPnL,
      avg_buy_price: avgBuyPrice,
      avg_sell_price: avgSellPrice > 0 ? avgSellPrice : undefined,
      current_price: undefined, // Would need to fetch
      total_bought: totalBought,
      total_sold: totalSold,
      current_balance: currentBalance
    };
  }

  // ============ Wallet Classification ============

  classifyWallet(trades: WalletTrade[], metrics: WalletMetrics): WalletClassification {
    const indicators = {
      transaction_speed: 0,
      pattern_consistency: 0,
      volume_size: 0,
      timing_precision: 0
    };

    const reasoning: string[] = [];
    let walletType: WalletTrader['wallet_type'] = 'normal';
    let confidence = 0.5;

    // Check for bot patterns
    if (trades.length > 0) {
      // Calculate average time between trades
      const sortedTrades = [...trades].sort((a, b) => 
        new Date(a.block_time).getTime() - new Date(b.block_time).getTime()
      );
      
      let totalTimeDiff = 0;
      let timeDiffCount = 0;
      
      for (let i = 1; i < sortedTrades.length; i++) {
        const timeDiff = new Date(sortedTrades[i].block_time).getTime() - 
                        new Date(sortedTrades[i-1].block_time).getTime();
        totalTimeDiff += timeDiff;
        timeDiffCount++;
      }
      
      const avgTimeBetweenTrades = timeDiffCount > 0 ? totalTimeDiff / timeDiffCount : 0;
      
      // Bot detection: Very fast trades (< 5 seconds average)
      if (avgTimeBetweenTrades < 5000 && trades.length > 10) {
        indicators.transaction_speed = 0.9;
        walletType = 'bot';
        confidence = 0.8;
        reasoning.push('Very fast transaction speed indicates bot activity');
      }
      
      // Whale detection: Large volume
      const totalVolume = trades.reduce((sum, t) => sum + t.sol_value, 0);
      if (totalVolume > 1000) { // > 1000 SOL total volume
        indicators.volume_size = 0.9;
        walletType = 'whale';
        confidence = 0.7;
        reasoning.push('High trading volume indicates whale status');
      }
    }

    // High performance might indicate influencer or skilled trader
    if (metrics.win_rate > 80 && metrics.graduated_tokens_count > 10) {
      if (walletType === 'normal') {
        walletType = 'influencer';
        confidence = 0.6;
        reasoning.push('High win rate and graduation count suggests influencer or skilled trader');
      }
    }

    return {
      wallet_type: walletType,
      confidence,
      reasoning,
      indicators
    };
  }

  // ============ Utility Methods ============

  async updateWalletMetrics(walletAddress: string): Promise<void> {
    // Calculate win rate
    const winRateQuery = `SELECT calculate_wallet_win_rate($1) as win_rate`;
    const winRateResult = await this.pool.query(winRateQuery, [walletAddress]);
    const winRate = winRateResult.rows[0]?.win_rate || 0;

    // Calculate average return multiple
    const avgReturnQuery = `SELECT get_wallet_avg_return_multiple($1) as avg_return`;
    const avgReturnResult = await this.pool.query(avgReturnQuery, [walletAddress]);
    const avgReturn = avgReturnResult.rows[0]?.avg_return || 1;

    // Get total PnL
    const pnlQuery = `
      SELECT 
        SUM(total_pnl_sol) as total_pnl,
        COUNT(DISTINCT token_mint) as token_count
      FROM wallet_positions
      WHERE wallet_address = $1`;
    const pnlResult = await this.pool.query(pnlQuery, [walletAddress]);
    const totalPnl = pnlResult.rows[0]?.total_pnl || 0;
    const tokenCount = pnlResult.rows[0]?.token_count || 0;

    // Update wallet metrics
    const updateQuery = `
      UPDATE wallet_traders SET
        win_rate = $2,
        avg_return_multiple = $3,
        total_pnl_sol = $4,
        graduated_tokens_traded = $5,
        updated_at = NOW()
      WHERE wallet_address = $1`;
    
    await this.pool.query(updateQuery, [
      walletAddress,
      winRate,
      avgReturn,
      totalPnl,
      tokenCount
    ]);
  }

  async cleanup(): Promise<void> {
    // Cleanup old data if needed
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Example: Remove old signals
    const query = `
      DELETE FROM token_smart_money_signals 
      WHERE signal_timestamp < $1`;
    
    await this.pool.query(query, [thirtyDaysAgo]);
  }
}

// Export singleton instance
export const walletTrackerService = new WalletTrackerService();