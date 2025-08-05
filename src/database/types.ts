/**
 * Centralized TypeScript interfaces for the database layer
 */

// Token related types
export interface Token {
  id?: string;
  mint_address: string;
  symbol?: string;
  name?: string;
  decimals: number;
  platform: 'pumpfun' | 'raydium' | 'raydium_launchpad';
  creation_signature: string;
  creation_timestamp: Date;
  creator_address: string;
  initial_supply?: string;
  metadata?: any;
  is_graduated?: boolean;
  graduation_timestamp?: Date;
  graduation_signature?: string;
}

// Pool related types
export interface Pool {
  id?: string;
  pool_address: string;
  token_id: string;
  base_mint: string;
  quote_mint: string;
  platform: 'pumpfun' | 'raydium' | 'raydium_launchpad';
  initial_price?: number;
  initial_price_usd?: string;
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
  latest_price_usd?: string;
  
  // Raydium specific
  lp_mint?: string;
  base_vault?: string;
  quote_vault?: string;
  
  // Additional fields from monitor service
  creation_signature?: string;
  creation_timestamp?: Date;
  initial_virtual_sol_reserves?: string;
  initial_virtual_token_reserves?: string;
  initial_real_sol_reserves?: string;
  initial_real_token_reserves?: string;
  creator_address?: string;
  fee_percentage?: number;
  is_active?: boolean;
  metadata?: any;
}

// Legacy PoolData interface for backward compatibility
export interface PoolData {
  pool_address: string;
  base_mint: string;
  quote_mint: string;
  platform: 'pumpfun' | 'raydium' | 'raydium_launchpad';
  initial_price?: number;
  initial_price_usd?: string;
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
  latest_price_usd?: string;
  
  // Raydium specific
  lp_mint?: string;
  base_vault?: string;
  quote_vault?: string;
}

// Transaction related types
export interface Transaction {
  signature: string;
  pool_id: string;
  token_id: string;
  block_time: Date;
  slot: number;
  type: 'buy' | 'sell' | 'add_liquidity' | 'remove_liquidity';
  user_address: string;
  sol_amount: string;
  token_amount: string;
  price_per_token?: number;
  pre_tx_sol_reserves?: string;
  pre_tx_token_reserves?: string;
  post_tx_sol_reserves?: string;
  post_tx_token_reserves?: string;
  fee_sol?: string;
  fee_token?: string;
  metadata?: any;
  
  // Legacy fields for backward compatibility
  amount_in?: string;
  amount_in_decimals?: number;
  amount_out?: string;
  amount_out_decimals?: number;
  protocol_fee?: string;
  platform_fee?: string;
  transaction_fee?: number;
  success?: boolean;
  raw_data?: any;
}

// Price related types
export interface PriceCandle {
  token_id: string;
  bucket: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_token: number;
  volume_sol: number;
  trade_count: number;
  buyer_count: number;
  seller_count: number;
}

export interface LatestPrice {
  price: number;
  bucket: Date;
  volume_sol_1h: number;
  trade_count_1h: number;
}

export interface PriceChange {
  current_price: number;
  previous_price: number;
  price_change: number;
  price_change_percent: number;
}

export interface VolumeStats {
  token_id: string;
  volume_sol_1h: number;
  volume_sol_24h: number;
  trade_count_1h: number;
  trade_count_24h: number;
  unique_traders_1h: number;
  unique_traders_24h: number;
}

// Monitor Service types (different from database types)
export interface TokenData {
  mint_address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  platform: 'pumpfun' | 'raydium' | 'raydium_launchpad';
  creation_signature: string;
  creation_timestamp: Date;
  creator_address: string;
  initial_supply?: string;
  metadata?: any;
}

export interface MonitorPoolData {
  pool_address: string;
  token_id: string;
  platform: 'pumpfun' | 'raydium' | 'raydium_launchpad';
  creation_signature: string;
  creation_timestamp: Date;
  initial_virtual_sol_reserves?: string;
  initial_virtual_token_reserves?: string;
  initial_real_sol_reserves?: string;
  initial_real_token_reserves?: string;
  creator_address?: string;
  fee_percentage?: number;
  is_active?: boolean;
  metadata?: any;
}

export interface TransactionData {
  signature: string;
  pool_id?: string;
  token_id?: string;
  mint_address?: string;
  pool_address?: string;
  block_time: Date;
  slot: number;
  type: 'buy' | 'sell' | 'add_liquidity' | 'remove_liquidity';
  user_address: string;
  sol_amount: string;
  token_amount: string;
  price_per_token?: number;
  pre_tx_sol_reserves?: string;
  pre_tx_token_reserves?: string;
  post_tx_sol_reserves?: string;
  post_tx_token_reserves?: string;
  fee_sol?: string;
  fee_token?: string;
  metadata?: any;
  platform?: 'pumpfun' | 'raydium' | 'raydium_launchpad';
}

export interface PriceData {
  pool_id: string;
  timestamp: Date;
  price_sol: number;
  price_usd?: number;
  volume_sol?: number;
  volume_usd?: number;
  high_price_sol?: number;
  low_price_sol?: number;
  open_price_sol?: number;
  close_price_sol?: number;
  transaction_count?: number;
}