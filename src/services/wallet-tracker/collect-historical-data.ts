#!/usr/bin/env node

import * as dotenv from 'dotenv';
dotenv.config();

import { graduatedTokenFetcher } from './graduated-token-fetcher';
import { transactionFetcher } from './transaction-fetcher';
import { walletProfileExtractor } from './wallet-profile-extractor';
import { walletTrackerService } from './wallet-tracker-service';
import { dataValidator } from './data-validator';
import { 
  GraduatedTokenData, 
  TransactionData, 
  WalletTrade,
  DataValidationResult 
} from './types';

class HistoricalDataCollector {
  private processedTokens = 0;
  private processedWallets = 0;
  private processedTransactions = 0;
  private startTime = Date.now();

  async run() {
    console.log('===========================================');
    console.log('   WALLET TRACKER - HISTORICAL DATA COLLECTION');
    console.log('   Phase 1: Data Collection & Validation');
    console.log('===========================================\n');

    try {
      // Step 1: Fetch graduated tokens
      console.log('📊 STEP 1: Fetching graduated tokens...');
      const graduatedTokens = await this.fetchAndValidateGraduatedTokens();
      
      if (graduatedTokens.length === 0) {
        console.error('❌ No graduated tokens found. Exiting...');
        process.exit(1);
      }

      console.log(`✅ Found ${graduatedTokens.length} validated graduated tokens\n`);

      // Step 2: Fetch transactions for graduated tokens
      console.log('📊 STEP 2: Fetching transactions for graduated tokens...');
      const tokenTransactions = await this.fetchTransactionsForTokens(graduatedTokens);
      console.log(`✅ Fetched transactions for ${tokenTransactions.size} tokens\n`);

      // Step 3: Extract unique wallets
      console.log('📊 STEP 3: Extracting unique wallet addresses...');
      const uniqueWallets = this.extractUniqueWallets(tokenTransactions);
      console.log(`✅ Found ${uniqueWallets.size} unique wallets\n`);

      // Step 4: Build wallet profiles
      console.log('📊 STEP 4: Building wallet profiles...');
      await this.buildWalletProfiles(uniqueWallets, tokenTransactions, graduatedTokens);
      console.log(`✅ Built ${this.processedWallets} wallet profiles\n`);

      // Step 5: Save wallet trades
      console.log('📊 STEP 5: Saving wallet trades to database...');
      await this.saveWalletTrades(tokenTransactions, graduatedTokens);
      console.log(`✅ Saved ${this.processedTransactions} trades\n`);

      // Step 6: Update wallet metrics
      console.log('📊 STEP 6: Updating wallet metrics...');
      await this.updateWalletMetrics(uniqueWallets);
      console.log(`✅ Updated metrics for ${uniqueWallets.size} wallets\n`);

      // Step 7: Generate report
      console.log('📊 STEP 7: Generating collection report...');
      await this.generateReport();

      console.log('\n✅ Historical data collection completed successfully!');
      
    } catch (error) {
      console.error('❌ Error during data collection:', error);
      process.exit(1);
    }
  }

  private async fetchAndValidateGraduatedTokens(): Promise<GraduatedTokenData[]> {
    const tokens = await graduatedTokenFetcher.fetchAllGraduatedTokens();
    
    // Validate each token
    const validTokens: GraduatedTokenData[] = [];
    let invalidCount = 0;
    
    for (const token of tokens) {
      const validation = dataValidator.validateGraduatedToken(token);
      if (validation.isValid) {
        validTokens.push(token);
      } else {
        console.warn(`⚠️  Invalid token ${token.mint_address}: ${validation.errors.join(', ')}`);
        invalidCount++;
      }
    }
    
    if (invalidCount > 0) {
      console.log(`⚠️  Filtered out ${invalidCount} invalid tokens`);
    }
    
    this.processedTokens = validTokens.length;
    return validTokens;
  }

  private async fetchTransactionsForTokens(
    tokens: GraduatedTokenData[]
  ): Promise<Map<string, TransactionData[]>> {
    const tokenTransactions = new Map<string, TransactionData[]>();
    const batchSize = 10;
    
    console.log(`Fetching transactions for ${tokens.length} tokens...`);
    
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      const progress = Math.min(i + batchSize, tokens.length);
      
      console.log(`  Processing tokens ${i + 1}-${progress} of ${tokens.length}...`);
      
      await Promise.all(
        batch.map(async (token) => {
          try {
            const transactions = await transactionFetcher.fetchPreGraduationTransactions(
              token.mint_address,
              token.graduation_timestamp
            );
            
            // Validate transactions
            const validTxs: TransactionData[] = [];
            for (const tx of transactions) {
              const validation = dataValidator.validateTransaction(tx);
              if (validation.isValid) {
                validTxs.push(tx);
              }
            }
            
            if (validTxs.length > 0) {
              tokenTransactions.set(token.mint_address, validTxs);
            }
          } catch (error) {
            console.warn(`  ⚠️  Failed to fetch transactions for ${token.mint_address}:`, error);
          }
        })
      );
      
      // Small delay between batches
      if (i + batchSize < tokens.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return tokenTransactions;
  }

  private extractUniqueWallets(
    tokenTransactions: Map<string, TransactionData[]>
  ): Set<string> {
    const wallets = new Set<string>();
    
    for (const [tokenMint, transactions] of tokenTransactions) {
      for (const tx of transactions) {
        // Include both buyers AND sellers to avoid foreign key errors
        wallets.add(tx.wallet);
      }
    }
    
    return wallets;
  }

  private async buildWalletProfiles(
    wallets: Set<string>,
    tokenTransactions: Map<string, TransactionData[]>,
    graduatedTokens: GraduatedTokenData[]
  ): Promise<void> {
    const walletProfiles = await walletProfileExtractor.extractMultipleProfiles(
      wallets,
      tokenTransactions
    );
    
    this.processedWallets = walletProfiles.size;
    
    // Validate profiles
    let validProfiles = 0;
    for (const [address, profile] of walletProfiles) {
      const validation = dataValidator.validateWalletProfile(profile);
      if (!validation.isValid) {
        console.warn(`⚠️  Invalid profile for ${address}: ${validation.errors.join(', ')}`);
      } else {
        validProfiles++;
      }
    }
    
    console.log(`  Validated ${validProfiles}/${walletProfiles.size} profiles`);
  }

  private async saveWalletTrades(
    tokenTransactions: Map<string, TransactionData[]>,
    graduatedTokens: GraduatedTokenData[]
  ): Promise<void> {
    const tokenMap = new Map(
      graduatedTokens.map(t => [t.mint_address, t])
    );
    
    let totalTrades = 0;
    const batchSize = 100;
    let tradeBatch: WalletTrade[] = [];
    
    for (const [tokenMint, transactions] of tokenTransactions) {
      const graduatedToken = tokenMap.get(tokenMint);
      const isGraduated = !!graduatedToken;
      
      const trades = transactionFetcher.convertToWalletTrades(
        transactions,
        isGraduated,
        graduatedToken?.graduation_timestamp
      );
      
      for (const trade of trades) {
        // Validate trade
        const validation = dataValidator.validateWalletTrade(trade);
        if (validation.isValid) {
          tradeBatch.push(trade);
          totalTrades++;
          
          // Save batch when it reaches size limit
          if (tradeBatch.length >= batchSize) {
            await walletTrackerService.saveTradeBatch(tradeBatch);
            console.log(`  Saved batch of ${tradeBatch.length} trades (total: ${totalTrades})`);
            tradeBatch = [];
          }
        }
      }
    }
    
    // Save remaining trades
    if (tradeBatch.length > 0) {
      await walletTrackerService.saveTradeBatch(tradeBatch);
      console.log(`  Saved final batch of ${tradeBatch.length} trades`);
    }
    
    this.processedTransactions = totalTrades;
  }

  private async updateWalletMetrics(wallets: Set<string>): Promise<void> {
    const batchSize = 50;
    const walletsArray = Array.from(wallets);
    
    for (let i = 0; i < walletsArray.length; i += batchSize) {
      const batch = walletsArray.slice(i, i + batchSize);
      const progress = Math.min(i + batchSize, walletsArray.length);
      
      console.log(`  Updating metrics for wallets ${i + 1}-${progress} of ${walletsArray.length}...`);
      
      await Promise.all(
        batch.map(async (walletAddress) => {
          try {
            await walletTrackerService.updateWalletMetrics(walletAddress);
          } catch (error) {
            console.warn(`  ⚠️  Failed to update metrics for ${walletAddress}:`, error);
          }
        })
      );
    }
  }

  private async generateReport(): Promise<void> {
    const elapsedTime = (Date.now() - this.startTime) / 1000;
    
    console.log('\n===========================================');
    console.log('   COLLECTION REPORT');
    console.log('===========================================');
    console.log(`📊 Execution Time: ${elapsedTime.toFixed(2)} seconds`);
    console.log(`📊 Processed Tokens: ${this.processedTokens}`);
    console.log(`📊 Processed Wallets: ${this.processedWallets}`);
    console.log(`📊 Processed Transactions: ${this.processedTransactions}`);
    
    // Get some statistics
    const topWallets = await walletTrackerService.getTopWallets(10);
    
    if (topWallets.length > 0) {
      console.log('\n📊 Top 10 Wallets by Score:');
      topWallets.forEach((wallet, index) => {
        console.log(`  ${index + 1}. ${wallet.wallet_address.substring(0, 8)}... - Score: ${wallet.trader_score.toFixed(2)}, PnL: ${wallet.total_pnl_sol.toFixed(2)} SOL`);
      });
    }
    
    // Get graduation stats
    const stats = await graduatedTokenFetcher.getGraduationStats();
    
    console.log('\n📊 Graduation Statistics:');
    console.log(`  Total Graduated Tokens: ${stats.total_graduated}`);
    console.log(`  First Graduation: ${new Date(stats.first_graduation).toLocaleDateString()}`);
    console.log(`  Latest Graduation: ${new Date(stats.latest_graduation).toLocaleDateString()}`);
    console.log(`  Raydium Graduations: ${stats.raydium_graduations}`);
    console.log(`  Meteora Graduations: ${stats.meteora_graduations}`);
  }
}

// Main execution
async function main() {
  const collector = new HistoricalDataCollector();
  await collector.run();
  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { HistoricalDataCollector };