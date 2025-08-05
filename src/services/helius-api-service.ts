import axios, { AxiosInstance } from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { Decimal } from 'decimal.js';
import { getDbPool } from '../database/connection';

interface HeliusConfig {
  apiKey: string;
  rpcUrl?: string;
  maxRetries?: number;
  retryDelay?: number;
}

interface TokenHolder {
  owner: string;
  amount: string;
  decimals: number;
  uiAmount: number;
  percentage?: number;
}

interface WalletAsset {
  id: string;
  content: {
    metadata: {
      name: string;
      symbol: string;
    };
  };
  token_info?: {
    balance: string;
    decimals: number;
  };
}

interface HeliusTokenAccount {
  address: string;
  mint: string;
  owner: string;
  amount: string;
  delegated_amount: string;
  frozen: boolean;
}

interface WalletAnalysis {
  address: string;
  creationDate?: Date;
  transactionCount: number;
  uniqueTokensHeld: number;
  totalVolumeSol: number;
  hasENS: boolean;
  walletAge: number;
  isContract: boolean;
  riskScore: number;
}

export class HeliusAPIService {
  private axios: AxiosInstance;
  private connection: Connection;
  private apiKey: string;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: HeliusConfig) {
    this.apiKey = config.apiKey;
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 1000;
    
    // Initialize Helius RPC connection
    const rpcUrl = config.rpcUrl || `https://mainnet.helius-rpc.com/?api-key=${config.apiKey}`;
    this.connection = new Connection(rpcUrl, 'confirmed');
    
    // Initialize Helius API client
    this.axios = axios.create({
      baseURL: 'https://api.helius.xyz/v0',
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  /**
   * Fetch all token holders for a given mint address
   */
  async getAllTokenHolders(mintAddress: string): Promise<TokenHolder[]> {
    console.log(`Fetching all holders for token ${mintAddress}...`);
    
    const holders: Map<string, TokenHolder> = new Map();
    let page = 1;
    const limit = 1000;
    
    try {
      // First, get token supply for percentage calculations
      const mintPubkey = new PublicKey(mintAddress);
      const supply = await this.connection.getTokenSupply(mintPubkey);
      const totalSupply = new Decimal(supply.value.amount);
      
      while (true) {
        const url = `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
        const body = {
          jsonrpc: "2.0",
          method: "getTokenAccounts",
          id: "helius-holder-fetch",
          params: {
            mint: mintAddress,
            page,
            limit,
            options: {
              showZeroBalance: true
            }
          },
        };
        
        const response = await this.retryRequest(() => 
          this.axios.post(url, body)
        );
        
        if (!response.data?.result?.token_accounts || response.data.result.token_accounts.length === 0) {
          break;
        }
        
        // Process token accounts
        for (const account of response.data.result.token_accounts) {
          if (account.amount && parseInt(account.amount) > 0) {
            const amount = new Decimal(account.amount);
            const percentage = amount.div(totalSupply).mul(100).toNumber();
            
            holders.set(account.owner, {
              owner: account.owner,
              amount: account.amount,
              decimals: supply.value.decimals,
              uiAmount: amount.div(new Decimal(10).pow(supply.value.decimals)).toNumber(),
              percentage,
            });
          }
        }
        
        // Check if we've fetched all accounts
        if (response.data.result.token_accounts.length < limit) {
          break;
        }
        
        page++;
        
        // Rate limiting
        await this.sleep(500); // Increased delay to avoid rate limits
      }
      
      console.log(`Found ${holders.size} unique holders for ${mintAddress}`);
      return Array.from(holders.values());
      
    } catch (error) {
      console.error(`Error fetching token holders for ${mintAddress}:`, error);
      throw error;
    }
  }

  /**
   * Fetch detailed wallet analysis for a list of addresses
   */
  async analyzeWallets(addresses: string[]): Promise<Map<string, WalletAnalysis>> {
    const analysisMap = new Map<string, WalletAnalysis>();
    const batchSize = 10; // Reduced batch size to avoid rate limits
    
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      
      try {
        // Process wallets sequentially to avoid rate limits
        for (const address of batch) {
          try {
            const analysis = await this.analyzeWallet(address);
            analysisMap.set(address, analysis);
            await this.sleep(200); // Delay between each wallet
          } catch (error) {
            console.error(`Error analyzing wallet ${address}:`, error);
          }
        }
        
        // Rate limiting between batches
        await this.sleep(1000);
        
      } catch (error) {
        console.error(`Error analyzing wallet batch:`, error);
      }
    }
    
    return analysisMap;
  }

  /**
   * Analyze a single wallet
   */
  async analyzeWallet(address: string): Promise<WalletAnalysis> {
    try {
      const pubkey = new PublicKey(address);
      
      // Get account info
      const accountInfo = await this.connection.getAccountInfo(pubkey);
      
      // Get transaction history
      const signatures = await this.connection.getSignaturesForAddress(pubkey, {
        limit: 1000,
      });
      
      // Get oldest transaction to determine wallet age
      const oldestTx = signatures[signatures.length - 1];
      const creationDate = oldestTx?.blockTime 
        ? new Date(oldestTx.blockTime * 1000)
        : new Date();
      
      const walletAge = Math.floor(
        (Date.now() - creationDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      
      // Get assets held by wallet
      const assets = await this.getWalletAssets(address);
      
      // Check for ENS/domain
      const hasENS = await this.checkForDomain(address);
      
      // Calculate risk score (0-100, higher is riskier)
      let riskScore = 0;
      
      // New wallet penalty
      if (walletAge < 7) riskScore += 30;
      else if (walletAge < 30) riskScore += 15;
      
      // Low activity penalty
      if (signatures.length < 10) riskScore += 20;
      else if (signatures.length < 50) riskScore += 10;
      
      // Single token focus penalty
      if (assets.length === 1) riskScore += 20;
      
      // Low balance penalty
      const solBalance = accountInfo ? accountInfo.lamports / 1e9 : 0;
      if (solBalance < 0.01) riskScore += 30;
      else if (solBalance < 0.1) riskScore += 15;
      
      return {
        address,
        creationDate,
        transactionCount: signatures.length,
        uniqueTokensHeld: assets.length,
        totalVolumeSol: 0, // Would need to analyze all transactions
        hasENS,
        walletAge,
        isContract: accountInfo?.executable || false,
        riskScore: Math.min(100, riskScore),
      };
      
    } catch (error) {
      console.error(`Error analyzing wallet ${address}:`, error);
      
      // Return default analysis on error
      return {
        address,
        transactionCount: 0,
        uniqueTokensHeld: 0,
        totalVolumeSol: 0,
        hasENS: false,
        walletAge: 0,
        isContract: false,
        riskScore: 100,
      };
    }
  }

  /**
   * Get all assets held by a wallet
   */
  async getWalletAssets(address: string): Promise<WalletAsset[]> {
    try {
      const url = `${this.axios.defaults.baseURL}/addresses/${address}/balances`;
      const params = { 'api-key': this.apiKey };
      
      const response = await this.retryRequest(() =>
        this.axios.get(url, { params })
      );
      
      return response.data?.tokens || [];
    } catch (error) {
      console.error(`Error fetching wallet assets for ${address}:`, error);
      return [];
    }
  }

  /**
   * Check if wallet has ENS/domain
   */
  async checkForDomain(address: string): Promise<boolean> {
    try {
      // Check for Solana Name Service, Bonfida, etc.
      // This is a simplified check - would need full SNS integration
      const url = `${this.axios.defaults.baseURL}/addresses/${address}/names`;
      const params = { 'api-key': this.apiKey };
      
      const response = await this.retryRequest(() =>
        this.axios.get(url, { params })
      );
      
      return response.data?.domains?.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Calculate distribution metrics for a list of holders
   */
  calculateDistributionMetrics(holders: TokenHolder[]) {
    // Sort by balance descending
    const sorted = holders.sort((a, b) => 
      new Decimal(b.amount).minus(new Decimal(a.amount)).toNumber()
    );
    
    const totalHolders = sorted.length;
    
    // Calculate concentration metrics
    const top1 = sorted[0]?.percentage || 0;
    const top5 = sorted.slice(0, 5).reduce((sum, h) => sum + (h.percentage || 0), 0);
    const top10 = sorted.slice(0, 10).reduce((sum, h) => sum + (h.percentage || 0), 0);
    const top20 = sorted.slice(0, 20).reduce((sum, h) => sum + (h.percentage || 0), 0);
    
    // Calculate Gini coefficient
    const balances = sorted.map(h => new Decimal(h.amount).toNumber());
    const gini = this.calculateGiniCoefficient(balances);
    
    // Calculate HHI (Herfindahl-Hirschman Index)
    const hhi = sorted.reduce((sum, h) => {
      const pct = h.percentage || 0;
      return sum + (pct * pct);
    }, 0);
    
    // Calculate holder categories
    const whales = sorted.filter(h => (h.percentage || 0) >= 5).length;
    const large = sorted.filter(h => {
      const pct = h.percentage || 0;
      return pct >= 1 && pct < 5;
    }).length;
    const medium = sorted.filter(h => {
      const pct = h.percentage || 0;
      return pct >= 0.1 && pct < 1;
    }).length;
    const small = sorted.filter(h => (h.percentage || 0) < 0.1).length;
    
    // Calculate balance statistics
    const amounts = sorted.map(h => h.uiAmount);
    const average = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const median = amounts[Math.floor(amounts.length / 2)];
    
    // Standard deviation
    const variance = amounts.reduce((sum, val) => {
      return sum + Math.pow(val - average, 2);
    }, 0) / amounts.length;
    const stdDev = Math.sqrt(variance);
    
    return {
      holderCount: totalHolders,
      topHolderPercentage: top1,
      top5Percentage: top5,
      top10Percentage: top10,
      top20Percentage: top20,
      giniCoefficient: gini,
      hhiIndex: hhi,
      averageBalance: average,
      medianBalance: median,
      stdDeviation: stdDev,
      whalesCount: whales,
      largeHoldersCount: large,
      mediumHoldersCount: medium,
      smallHoldersCount: small,
    };
  }

  /**
   * Calculate Gini coefficient
   */
  private calculateGiniCoefficient(values: number[]): number {
    const sorted = values.sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    
    if (sum === 0 || n === 0) return 0;
    
    let giniSum = 0;
    for (let i = 0; i < n; i++) {
      giniSum += (2 * (i + 1) - n - 1) * sorted[i];
    }
    
    return giniSum / (n * sum);
  }

  /**
   * Retry helper for API requests
   */
  private async retryRequest<T>(
    fn: () => Promise<T>,
    retries = this.maxRetries
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      if (retries > 0 && error.response?.status >= 500) {
        await this.sleep(this.retryDelay);
        return this.retryRequest(fn, retries - 1);
      }
      throw error;
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Save holder snapshot to database
   */
  async saveHolderSnapshot(
    tokenId: string,
    holders: TokenHolder[],
    bondingCurveProgress: number
  ): Promise<void> {
    const db = getDbPool();
    const metrics = this.calculateDistributionMetrics(holders);
    
    const query = `
      INSERT INTO holder_snapshots (
        token_id, snapshot_time, bonding_curve_progress, holder_count,
        top_holder_percentage, top_5_percentage, top_10_percentage, top_20_percentage,
        gini_coefficient, hhi_index, average_balance, median_balance, std_deviation,
        whales_count, large_holders_count, medium_holders_count, small_holders_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `;
    
    await db.query(query, [
      tokenId,
      new Date(),
      bondingCurveProgress,
      metrics.holderCount,
      metrics.topHolderPercentage,
      metrics.top5Percentage,
      metrics.top10Percentage,
      metrics.top20Percentage,
      metrics.giniCoefficient,
      metrics.hhiIndex,
      metrics.averageBalance,
      metrics.medianBalance,
      metrics.stdDeviation,
      metrics.whalesCount,
      metrics.largeHoldersCount,
      metrics.mediumHoldersCount,
      metrics.smallHoldersCount,
    ]);
  }

  /**
   * Save individual holders to database
   */
  async saveTokenHolders(
    tokenId: string,
    holders: TokenHolder[],
    walletAnalyses: Map<string, WalletAnalysis>
  ): Promise<void> {
    const db = getDbPool();
    
    for (const holder of holders) {
      const analysis = walletAnalyses.get(holder.owner);
      
      const query = `
        INSERT INTO token_holders (
          token_id, wallet_address, balance, balance_percentage,
          first_seen, last_seen, transaction_count, wallet_age_days,
          is_bot_suspected, is_contract, has_ens_domain, wallet_score
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (token_id, wallet_address) 
        DO UPDATE SET
          balance = $3,
          balance_percentage = $4,
          last_seen = $6,
          transaction_count = $7,
          wallet_age_days = $8,
          is_bot_suspected = $9,
          is_contract = $10,
          has_ens_domain = $11,
          wallet_score = $12,
          updated_at = NOW()
      `;
      
      const isBotSuspected = analysis ? analysis.riskScore > 70 : false;
      const walletScore = analysis ? 100 - analysis.riskScore : 50;
      
      await db.query(query, [
        tokenId,
        holder.owner,
        holder.uiAmount,
        holder.percentage,
        new Date(),
        new Date(),
        analysis?.transactionCount || 0,
        analysis?.walletAge || 0,
        isBotSuspected,
        analysis?.isContract || false,
        analysis?.hasENS || false,
        walletScore,
      ]);
    }
  }
}

// Export singleton instance
let heliusService: HeliusAPIService | null = null;

export function getHeliusService(apiKey?: string): HeliusAPIService {
  if (!heliusService) {
    if (!apiKey) {
      throw new Error('Helius API key required for initialization');
    }
    heliusService = new HeliusAPIService({ apiKey });
  }
  return heliusService;
}