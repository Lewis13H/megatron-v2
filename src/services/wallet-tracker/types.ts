// Wallet Tracker Types and Interfaces

export interface WalletTrader {
  id?: number;
  wallet_address: string;
  wallet_type: 'normal' | 'bot' | 'dev' | 'whale' | 'sybil' | 'influencer';
  cluster_id?: string;
  cluster_confidence?: number;
  reputation_score: number;
  first_seen_at: Date;
  last_activity_at: Date;
  total_trades: number;
  graduated_tokens_traded: number;
  total_pnl_sol: number;
  total_pnl_usd: number;
  win_rate: number;
  avg_hold_time_minutes: number;
  avg_return_multiple: number;
  trader_score: number;
  score_updated_at?: Date;
  score_decay_factor: number;
  days_inactive: number;
  suspicious_activity_count: number;
  last_audit_at?: Date;
  audit_notes?: any;
  metadata?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface WalletRelationship {
  id?: number;
  wallet_a: string;
  wallet_b: string;
  relationship_type: 'funds_transfer' | 'same_tx_pattern' | 'timing_correlation' | 'same_creator';
  interaction_count: number;
  confidence_score: number;
  first_interaction?: Date;
  last_interaction?: Date;
  metadata?: any;
  created_at?: Date;
}

export interface WalletCluster {
  cluster_id: string;
  cluster_type: 'family' | 'bot_network' | 'trading_group' | 'unknown';
  wallet_count: number;
  primary_wallet?: string;
  risk_score: number;
  detection_method?: string;
  detection_confidence: number;
  combined_pnl_sol?: number;
  combined_score?: number;
  metadata?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface WalletTrade {
  id?: number;
  wallet_address: string;
  token_mint: string;
  trade_type: 'buy' | 'sell';
  amount: number;
  price_sol: number;
  price_usd?: number;
  sol_value: number;
  transaction_hash: string;
  block_time: Date;
  is_graduated_token: boolean;
  time_to_graduation_minutes?: number;
  created_at?: Date;
}

export interface WalletPosition {
  id?: number;
  wallet_address: string;
  token_mint: string;
  total_bought: number;
  total_sold: number;
  current_balance: number;
  avg_buy_price?: number;
  avg_sell_price?: number;
  realized_pnl_sol: number;
  unrealized_pnl_sol: number;
  total_pnl_sol?: number;
  first_buy_at?: Date;
  last_sell_at?: Date;
  is_graduated: boolean;
  graduation_entry_timing?: number;
  position_score: number;
  updated_at?: Date;
}

export interface WalletScoreHistory {
  id?: number;
  wallet_address: string;
  score_timestamp: Date;
  trader_score: number;
  components: ScoreComponents;
  graduated_tokens_count?: number;
  total_pnl_sol?: number;
  win_rate?: number;
  avg_multiplier?: number;
  consistency_score?: number;
  timing_score?: number;
  created_at?: Date;
}

export interface TokenSmartMoneySignal {
  id?: number;
  token_mint: string;
  signal_timestamp: Date;
  smart_wallets_count: number;
  avg_trader_score?: number;
  total_smart_money_invested_sol?: number;
  top_traders?: TopTrader[];
  signal_strength?: number;
  created_at?: Date;
}

export interface ScoreComponents {
  profitability: {
    total_pnl: number;
    avg_return: number;
    best_trade: number;
  };
  consistency: {
    win_rate: number;
    profit_consistency: number;
    graduation_hit_rate: number;
  };
  timing: {
    early_entry: number;
    exit_efficiency: number;
    market_timing: number;
  };
  activity: {
    volume: number;
    diversification: number;
    longevity: number;
  };
}

export interface TopTrader {
  address: string;
  score: number;
  investment: number;
  entry_price?: number;
}

export interface GraduatedTokenData {
  mint_address: string;
  graduation_timestamp: Date;
  graduation_signature: string;
  graduation_price: number;
  peak_price?: number;
  final_market_cap?: number;
  migration_platform: 'raydium' | 'meteora' | 'other';
  data_source: 'primary' | 'fallback' | 'local_cache';
  validation_status: 'verified' | 'pending' | 'disputed';
}

export interface TransactionData {
  signature: string;
  blockTime: Date;
  type: 'buy' | 'sell';
  wallet: string;
  tokenMint: string;
  amount: number;
  price: number;
  solValue: number;
}

export interface WalletMetrics {
  wallet_address: string;
  total_pnl_sol: number;
  total_pnl_usd: number;
  win_rate: number;
  avg_return_multiple: number;
  graduated_tokens_count: number;
  avg_hold_time_minutes: number;
  first_buy_timing_avg: number; // Minutes before graduation
  total_trades: number;
}

export interface DataValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  data?: any;
}

export interface PnLCalculation {
  wallet_address: string;
  token_mint: string;
  realized_pnl: number;
  unrealized_pnl: number;
  total_pnl: number;
  avg_buy_price: number;
  avg_sell_price?: number;
  current_price?: number;
  total_bought: number;
  total_sold: number;
  current_balance: number;
}

export interface WalletClassification {
  wallet_type: 'normal' | 'bot' | 'dev' | 'whale' | 'sybil' | 'influencer';
  confidence: number;
  reasoning: string[];
  indicators: {
    transaction_speed?: number;
    pattern_consistency?: number;
    volume_size?: number;
    timing_precision?: number;
  };
}