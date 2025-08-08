-- Migration: Create Wallet Tracker Tables
-- Purpose: Track wallet performance with graduated tokens for smart money identification

-- Drop existing tables if they exist
DROP TABLE IF EXISTS token_smart_money_signals CASCADE;
DROP TABLE IF EXISTS wallet_scores_history CASCADE;
DROP TABLE IF EXISTS wallet_positions CASCADE;
DROP TABLE IF EXISTS wallet_trades CASCADE;
DROP TABLE IF EXISTS wallet_clusters CASCADE;
DROP TABLE IF EXISTS wallet_relationships CASCADE;
DROP TABLE IF EXISTS wallet_traders CASCADE;

-- Create wallet traders table (main wallet profile table)
CREATE TABLE wallet_traders (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) UNIQUE NOT NULL,
  
  -- Wallet classification
  wallet_type VARCHAR(20) DEFAULT 'normal' CHECK (wallet_type IN ('normal', 'bot', 'dev', 'whale', 'sybil', 'influencer')),
  cluster_id VARCHAR(36),
  cluster_confidence DECIMAL(3, 2) CHECK (cluster_confidence >= 0 AND cluster_confidence <= 1),
  reputation_score DECIMAL(10, 2) DEFAULT 50 CHECK (reputation_score >= 0),
  
  -- Activity tracking
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMP NOT NULL DEFAULT NOW(),
  total_trades INTEGER DEFAULT 0 CHECK (total_trades >= 0),
  graduated_tokens_traded INTEGER DEFAULT 0 CHECK (graduated_tokens_traded >= 0),
  
  -- Performance metrics
  total_pnl_sol DECIMAL(20, 9) DEFAULT 0,
  total_pnl_usd DECIMAL(20, 2) DEFAULT 0,
  win_rate DECIMAL(5, 2) DEFAULT 0 CHECK (win_rate >= 0 AND win_rate <= 100),
  avg_hold_time_minutes INTEGER DEFAULT 0 CHECK (avg_hold_time_minutes >= 0),
  avg_return_multiple DECIMAL(10, 2) DEFAULT 0,
  
  -- Scoring
  trader_score DECIMAL(10, 2) DEFAULT 0 CHECK (trader_score >= 0 AND trader_score <= 1000),
  score_updated_at TIMESTAMP,
  score_decay_factor DECIMAL(3, 2) DEFAULT 1.0 CHECK (score_decay_factor >= 0 AND score_decay_factor <= 1),
  days_inactive INTEGER DEFAULT 0 CHECK (days_inactive >= 0),
  
  -- Anti-gaming measures
  suspicious_activity_count INTEGER DEFAULT 0 CHECK (suspicious_activity_count >= 0),
  last_audit_at TIMESTAMP,
  audit_notes JSONB DEFAULT '{}',
  
  -- Metadata
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for wallet_traders
CREATE INDEX idx_wallet_traders_address ON wallet_traders(wallet_address);
CREATE INDEX idx_wallet_traders_score ON wallet_traders(trader_score DESC);
CREATE INDEX idx_wallet_traders_pnl ON wallet_traders(total_pnl_sol DESC);
CREATE INDEX idx_wallet_traders_cluster ON wallet_traders(cluster_id);
CREATE INDEX idx_wallet_traders_last_activity ON wallet_traders(last_activity_at DESC);
CREATE INDEX idx_wallet_traders_type ON wallet_traders(wallet_type);

-- Wallet relationships for Sybil detection
CREATE TABLE wallet_relationships (
  id SERIAL PRIMARY KEY,
  wallet_a VARCHAR(44) NOT NULL,
  wallet_b VARCHAR(44) NOT NULL,
  relationship_type VARCHAR(30) NOT NULL CHECK (relationship_type IN ('funds_transfer', 'same_tx_pattern', 'timing_correlation', 'same_creator')),
  interaction_count INTEGER DEFAULT 1 CHECK (interaction_count > 0),
  confidence_score DECIMAL(3, 2) CHECK (confidence_score >= 0 AND confidence_score <= 1),
  first_interaction TIMESTAMP,
  last_interaction TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_a, wallet_b, relationship_type)
);

-- Create indexes for wallet_relationships
CREATE INDEX idx_wallet_relationships_wallet_a ON wallet_relationships(wallet_a);
CREATE INDEX idx_wallet_relationships_wallet_b ON wallet_relationships(wallet_b);
CREATE INDEX idx_wallet_relationships_type ON wallet_relationships(relationship_type);

-- Wallet clusters for grouped wallets
CREATE TABLE wallet_clusters (
  cluster_id VARCHAR(36) PRIMARY KEY,
  cluster_type VARCHAR(30) NOT NULL CHECK (cluster_type IN ('family', 'bot_network', 'trading_group', 'unknown')),
  wallet_count INTEGER NOT NULL CHECK (wallet_count > 0),
  primary_wallet VARCHAR(44),
  risk_score DECIMAL(3, 2) CHECK (risk_score >= 0 AND risk_score <= 1),
  detection_method VARCHAR(50),
  detection_confidence DECIMAL(3, 2) CHECK (detection_confidence >= 0 AND detection_confidence <= 1),
  combined_pnl_sol DECIMAL(20, 9),
  combined_score DECIMAL(10, 2),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for wallet_clusters
CREATE INDEX idx_wallet_clusters_type ON wallet_clusters(cluster_type);
CREATE INDEX idx_wallet_clusters_risk ON wallet_clusters(risk_score DESC);

-- Wallet trades history (using TimescaleDB if available)
CREATE TABLE wallet_trades (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  trade_type VARCHAR(10) NOT NULL CHECK (trade_type IN ('buy', 'sell')),
  amount DECIMAL(20, 6) NOT NULL CHECK (amount > 0),
  price_sol DECIMAL(20, 9) NOT NULL CHECK (price_sol > 0),
  price_usd DECIMAL(20, 6),
  sol_value DECIMAL(20, 9) NOT NULL CHECK (sol_value > 0),
  transaction_hash VARCHAR(88) NOT NULL,
  block_time TIMESTAMP NOT NULL,
  is_graduated_token BOOLEAN DEFAULT FALSE,
  time_to_graduation_minutes INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  FOREIGN KEY (wallet_address) REFERENCES wallet_traders(wallet_address) ON DELETE CASCADE
);

-- Create indexes for wallet_trades
CREATE INDEX idx_wallet_trades_wallet ON wallet_trades(wallet_address);
CREATE INDEX idx_wallet_trades_token ON wallet_trades(token_mint);
CREATE INDEX idx_wallet_trades_time ON wallet_trades(block_time DESC);
CREATE INDEX idx_wallet_trades_graduated ON wallet_trades(is_graduated_token) WHERE is_graduated_token = true;
CREATE INDEX idx_wallet_trades_type ON wallet_trades(trade_type);

-- Try to convert to TimescaleDB hypertable if extension is available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('wallet_trades', 'block_time', if_not_exists => TRUE);
    RAISE NOTICE 'Successfully created hypertable for wallet_trades';
  ELSE
    RAISE NOTICE 'TimescaleDB not available, using regular table for wallet_trades';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not create hypertable: %', SQLERRM;
END $$;

-- Wallet token positions
CREATE TABLE wallet_positions (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  total_bought DECIMAL(20, 6) DEFAULT 0 CHECK (total_bought >= 0),
  total_sold DECIMAL(20, 6) DEFAULT 0 CHECK (total_sold >= 0),
  current_balance DECIMAL(20, 6) DEFAULT 0 CHECK (current_balance >= 0),
  avg_buy_price DECIMAL(20, 9),
  avg_sell_price DECIMAL(20, 9),
  realized_pnl_sol DECIMAL(20, 9) DEFAULT 0,
  unrealized_pnl_sol DECIMAL(20, 9) DEFAULT 0,
  total_pnl_sol DECIMAL(20, 9) GENERATED ALWAYS AS (realized_pnl_sol + unrealized_pnl_sol) STORED,
  first_buy_at TIMESTAMP,
  last_sell_at TIMESTAMP,
  is_graduated BOOLEAN DEFAULT FALSE,
  graduation_entry_timing INTEGER,
  position_score DECIMAL(10, 2) DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_address, token_mint),
  FOREIGN KEY (wallet_address) REFERENCES wallet_traders(wallet_address) ON DELETE CASCADE
);

-- Create indexes for wallet_positions
CREATE INDEX idx_wallet_positions_wallet ON wallet_positions(wallet_address);
CREATE INDEX idx_wallet_positions_token ON wallet_positions(token_mint);
CREATE INDEX idx_wallet_positions_pnl ON wallet_positions(total_pnl_sol DESC);
CREATE INDEX idx_wallet_positions_graduated ON wallet_positions(is_graduated) WHERE is_graduated = true;

-- Wallet scoring history
CREATE TABLE wallet_scores_history (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) NOT NULL,
  score_timestamp TIMESTAMP NOT NULL,
  trader_score DECIMAL(10, 2) NOT NULL CHECK (trader_score >= 0 AND trader_score <= 1000),
  components JSONB NOT NULL,
  graduated_tokens_count INTEGER,
  total_pnl_sol DECIMAL(20, 9),
  win_rate DECIMAL(5, 2),
  avg_multiplier DECIMAL(10, 2),
  consistency_score DECIMAL(10, 2),
  timing_score DECIMAL(10, 2),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  FOREIGN KEY (wallet_address) REFERENCES wallet_traders(wallet_address) ON DELETE CASCADE
);

-- Create indexes for wallet_scores_history
CREATE INDEX idx_wallet_scores_wallet ON wallet_scores_history(wallet_address);
CREATE INDEX idx_wallet_scores_time ON wallet_scores_history(score_timestamp DESC);

-- Try to convert to TimescaleDB hypertable if extension is available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('wallet_scores_history', 'score_timestamp', if_not_exists => TRUE);
    RAISE NOTICE 'Successfully created hypertable for wallet_scores_history';
  ELSE
    RAISE NOTICE 'TimescaleDB not available, using regular table for wallet_scores_history';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not create hypertable: %', SQLERRM;
END $$;

-- Token smart money signals
CREATE TABLE token_smart_money_signals (
  id SERIAL PRIMARY KEY,
  token_mint VARCHAR(44) NOT NULL,
  signal_timestamp TIMESTAMP NOT NULL,
  smart_wallets_count INTEGER DEFAULT 0 CHECK (smart_wallets_count >= 0),
  avg_trader_score DECIMAL(10, 2),
  total_smart_money_invested_sol DECIMAL(20, 9),
  top_traders JSONB DEFAULT '[]',
  signal_strength DECIMAL(5, 2) CHECK (signal_strength >= 0 AND signal_strength <= 100),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for token_smart_money_signals
CREATE INDEX idx_smart_signals_token ON token_smart_money_signals(token_mint);
CREATE INDEX idx_smart_signals_time ON token_smart_money_signals(signal_timestamp DESC);
CREATE INDEX idx_smart_signals_strength ON token_smart_money_signals(signal_strength DESC);

-- Try to convert to TimescaleDB hypertable if extension is available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('token_smart_money_signals', 'signal_timestamp', if_not_exists => TRUE);
    RAISE NOTICE 'Successfully created hypertable for token_smart_money_signals';
  ELSE
    RAISE NOTICE 'TimescaleDB not available, using regular table for token_smart_money_signals';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not create hypertable: %', SQLERRM;
END $$;

-- Create update trigger for updated_at columns
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_wallet_traders_updated_at
  BEFORE UPDATE ON wallet_traders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wallet_clusters_updated_at
  BEFORE UPDATE ON wallet_clusters
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wallet_positions_updated_at
  BEFORE UPDATE ON wallet_positions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Create helper functions
CREATE OR REPLACE FUNCTION calculate_wallet_win_rate(p_wallet_address VARCHAR)
RETURNS DECIMAL AS $$
DECLARE
  v_win_rate DECIMAL;
BEGIN
  SELECT 
    CASE 
      WHEN COUNT(*) = 0 THEN 0
      ELSE (COUNT(*) FILTER (WHERE total_pnl_sol > 0)::DECIMAL / COUNT(*)) * 100
    END INTO v_win_rate
  FROM wallet_positions
  WHERE wallet_address = p_wallet_address
    AND (total_sold > 0 OR current_balance = 0);
  
  RETURN COALESCE(v_win_rate, 0);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_wallet_avg_return_multiple(p_wallet_address VARCHAR)
RETURNS DECIMAL AS $$
DECLARE
  v_avg_multiple DECIMAL;
BEGIN
  SELECT 
    AVG(
      CASE 
        WHEN avg_buy_price > 0 AND avg_sell_price > 0 THEN avg_sell_price / avg_buy_price
        ELSE 1
      END
    ) INTO v_avg_multiple
  FROM wallet_positions
  WHERE wallet_address = p_wallet_address
    AND total_sold > 0
    AND avg_buy_price > 0;
  
  RETURN COALESCE(v_avg_multiple, 1);
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO postgres;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO postgres;

-- Add comments
COMMENT ON TABLE wallet_traders IS 'Main wallet profile table tracking performance and reputation';
COMMENT ON TABLE wallet_relationships IS 'Tracks relationships between wallets for Sybil detection';
COMMENT ON TABLE wallet_clusters IS 'Groups of related wallets identified as potentially coordinated';
COMMENT ON TABLE wallet_trades IS 'Historical record of all wallet trades';
COMMENT ON TABLE wallet_positions IS 'Current and historical positions for each wallet-token pair';
COMMENT ON TABLE wallet_scores_history IS 'Time-series history of wallet scores';
COMMENT ON TABLE token_smart_money_signals IS 'Smart money signals generated for tokens based on wallet activity';