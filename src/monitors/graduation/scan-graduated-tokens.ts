import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { struct, bool, u64 } from "@coral-xyz/borsh";
import { monitorService } from "../../database";
import { getDbPool } from "../../database/connection";

// Bonding curve account structure
const bondingCurveStructure = struct([
  u64("discriminator"),
  u64("virtualTokenReserves"),
  u64("virtualSolReserves"),
  u64("realTokenReserves"),
  u64("realSolReserves"),
  u64("tokenTotalSupply"),
  bool("complete"),
]);

class GraduatedTokenScanner {
  private connection: Connection;
  private PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

  constructor() {
    // Use Helius RPC endpoint to avoid rate limiting
    const heliusRpc = process.env.HELIUS_RPC || 
      (process.env.HELIUS_API_KEY ? 
        `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 
        "https://api.mainnet-beta.solana.com");
    
    this.connection = new Connection(
      heliusRpc,
      {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: 60000
      }
    );
    
    console.log(`🔗 Using RPC: ${heliusRpc.includes('helius') ? 'Helius' : 'Public Solana'}`);
  }

  async scanForGraduatedTokens() {
    console.log("\n" + "=".repeat(80));
    console.log("🔍 SCANNING FOR GRADUATED TOKENS");
    console.log("=".repeat(80));
    console.log("📍 This will check all active Pump.fun tokens for graduation status");
    console.log("=".repeat(80) + "\n");

    try {
      // Get all active pump.fun tokens from database
      const pool = getDbPool();
      const query = `
        SELECT DISTINCT
          t.id as token_id,
          t.mint_address,
          t.symbol,
          t.name,
          t.is_graduated,
          t.created_at,
          p.id as pool_id,
          p.pool_address,
          p.bonding_curve_address,
          p.bonding_curve_progress,
          p.status as pool_status
        FROM tokens t
        JOIN pools p ON t.id = p.token_id
        WHERE t.platform = 'pumpfun'
          AND (t.is_graduated = FALSE OR t.is_graduated IS NULL)
          AND p.bonding_curve_address IS NOT NULL
          AND p.platform = 'pumpfun'
        ORDER BY t.created_at DESC
      `;

      const result = await pool.query(query);
      console.log(`Found ${result.rows.length} Pump.fun tokens to check\n`);

      let graduatedCount = 0;
      let errorCount = 0;

      for (const row of result.rows) {
        try {
          // Check if bonding curve is complete
          const isGraduated = await this.checkBondingCurveComplete(row.bonding_curve_address);
          
          if (isGraduated) {
            console.log(`\n✅ GRADUATED TOKEN FOUND!`);
            console.log(`   Token: ${row.symbol} (${row.name})`);
            console.log(`   Mint: ${row.mint_address}`);
            console.log(`   Bonding Curve: ${row.bonding_curve_address}`);
            console.log(`   Previous Progress: ${row.bonding_curve_progress}%`);

            // Update database
            await this.updateGraduatedToken(
              row.token_id,
              row.pool_id,
              row.mint_address,
              row.bonding_curve_address
            );

            graduatedCount++;
          } else {
            // Check if progress needs updating (near 100%)
            const bondingCurveData = await this.getBondingCurveData(row.bonding_curve_address);
            if (bondingCurveData) {
              const progress = this.calculateProgress(bondingCurveData);
              
              // Update progress if significantly different
              if (Math.abs(progress - (row.bonding_curve_progress || 0)) > 1) {
                console.log(`   Updating progress for ${row.symbol}: ${row.bonding_curve_progress}% → ${progress.toFixed(2)}%`);
                await monitorService.updatePoolProgress(row.pool_id, progress);
              }
            }
          }
        } catch (error) {
          console.error(`Error checking token ${row.symbol}:`, error);
          errorCount++;
        }

        // Rate limiting to avoid RPC throttling (reduced for Helius)
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      console.log("\n" + "=".repeat(80));
      console.log("📊 SCAN COMPLETE");
      console.log(`✅ Graduated tokens found: ${graduatedCount}`);
      console.log(`❌ Errors encountered: ${errorCount}`);
      console.log(`📈 Total tokens checked: ${result.rows.length}`);
      console.log("=".repeat(80) + "\n");

    } catch (error) {
      console.error("Fatal error during scan:", error);
    }
  }

  async checkBondingCurveComplete(bondingCurveAddress: string): Promise<boolean> {
    try {
      const pubkey = new PublicKey(bondingCurveAddress);
      const accountInfo = await this.connection.getAccountInfo(pubkey);
      
      if (!accountInfo || !accountInfo.data) {
        return false;
      }

      const bondingCurveData = bondingCurveStructure.decode(accountInfo.data);
      return bondingCurveData.complete === true;
    } catch (error: any) {
      // Handle rate limiting specifically
      if (error.message?.includes('429') || error.message?.includes('Too Many Requests')) {
        console.error(`⚠️  Rate limited on ${bondingCurveAddress}, waiting...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Retry once after delay
        try {
          const pubkey = new PublicKey(bondingCurveAddress);
          const accountInfo = await this.connection.getAccountInfo(pubkey);
          if (!accountInfo || !accountInfo.data) return false;
          const bondingCurveData = bondingCurveStructure.decode(accountInfo.data);
          return bondingCurveData.complete === true;
        } catch (retryError) {
          console.error(`Error on retry for ${bondingCurveAddress}:`, retryError);
          return false;
        }
      }
      console.error(`Error checking bonding curve ${bondingCurveAddress}:`, error);
      return false;
    }
  }

  async getBondingCurveData(bondingCurveAddress: string): Promise<any | null> {
    try {
      const pubkey = new PublicKey(bondingCurveAddress);
      const accountInfo = await this.connection.getAccountInfo(pubkey);
      
      if (!accountInfo || !accountInfo.data) {
        return null;
      }

      return bondingCurveStructure.decode(accountInfo.data);
    } catch (error: any) {
      // Handle rate limiting
      if (error.message?.includes('429') || error.message?.includes('Too Many Requests')) {
        console.error(`⚠️  Rate limited, waiting before retry...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Retry once
        try {
          const pubkey = new PublicKey(bondingCurveAddress);
          const accountInfo = await this.connection.getAccountInfo(pubkey);
          if (!accountInfo || !accountInfo.data) return null;
          return bondingCurveStructure.decode(accountInfo.data);
        } catch (retryError) {
          return null;
        }
      }
      return null;
    }
  }

  calculateProgress(bondingCurveData: any): number {
    const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000 * 1e6;
    const TOTAL_SELLABLE_TOKENS = 793_100_000 * 1e6;
    
    const virtualTokenReserves = Number(bondingCurveData.virtualTokenReserves);
    const tokensSold = INITIAL_VIRTUAL_TOKEN_RESERVES - virtualTokenReserves;
    const progress = (tokensSold / TOTAL_SELLABLE_TOKENS) * 100;
    
    return Math.min(Math.max(progress, 0), 100);
  }

  async updateGraduatedToken(
    tokenId: string,
    poolId: string,
    mintAddress: string,
    bondingCurveAddress: string
  ) {
    try {
      // Mark token as graduated
      await monitorService.markTokenAsGraduated(tokenId, null);
      
      // Update pool status and progress
      await monitorService.updatePoolStatus(poolId, 'graduated');
      await monitorService.updatePoolProgress(poolId, 100.00);

      console.log(`   ✅ Database updated successfully`);

      // Check for Raydium pool
      await this.checkForRadiumPool(mintAddress);

    } catch (error) {
      console.error(`Error updating graduated token in database:`, error);
    }
  }

  async checkForRadiumPool(tokenMint: string) {
    try {
      // Query for existing Raydium pool
      const pool = getDbPool();
      const query = `
        SELECT p.pool_address, p.created_at
        FROM pools p
        JOIN tokens t ON p.token_id = t.id
        WHERE t.mint_address = $1
          AND p.platform = 'raydium'
        LIMIT 1
      `;
      
      const result = await pool.query(query, [tokenMint]);
      
      if (result.rows.length > 0) {
        console.log(`   🏊 Raydium pool found: ${result.rows[0].pool_address}`);
        console.log(`   📅 Created: ${new Date(result.rows[0].created_at).toLocaleString()}`);
      } else {
        console.log(`   ⏳ No Raydium pool found yet (may need to run Raydium monitor)`);
      }
    } catch (error) {
      console.error(`Error checking for Raydium pool:`, error);
    }
  }

  async scanSpecificToken(mintAddress: string) {
    console.log(`\n🔍 Scanning specific token: ${mintAddress}`);
    
    try {
      const pool = getDbPool();
      const query = `
        SELECT DISTINCT
          t.id as token_id,
          t.mint_address,
          t.symbol,
          t.name,
          t.is_graduated,
          p.id as pool_id,
          p.pool_address,
          p.bonding_curve_address,
          p.bonding_curve_progress,
          p.status as pool_status
        FROM tokens t
        JOIN pools p ON t.id = p.token_id
        WHERE t.mint_address = $1
          AND p.platform = 'pumpfun'
        LIMIT 1
      `;

      const result = await pool.query(query, [mintAddress]);
      
      if (result.rows.length === 0) {
        console.log("❌ Token not found in database or not a Pump.fun token");
        return;
      }

      const row = result.rows[0];
      console.log(`\nToken: ${row.symbol} (${row.name})`);
      console.log(`Current Status: ${row.is_graduated ? 'Graduated' : 'Active'}`);
      console.log(`Bonding Curve Progress: ${row.bonding_curve_progress}%`);
      console.log(`Bonding Curve Address: ${row.bonding_curve_address}`);

      if (row.bonding_curve_address) {
        const isGraduated = await this.checkBondingCurveComplete(row.bonding_curve_address);
        
        if (isGraduated && !row.is_graduated) {
          console.log("\n✅ TOKEN HAS GRADUATED! Updating database...");
          await this.updateGraduatedToken(
            row.token_id,
            row.pool_id,
            row.mint_address,
            row.bonding_curve_address
          );
        } else if (isGraduated && row.is_graduated) {
          console.log("\n✅ Token is already marked as graduated in database");
          await this.checkForRadiumPool(row.mint_address);
        } else {
          console.log("\n❌ Token has not graduated yet");
          
          // Get current progress
          const bondingCurveData = await this.getBondingCurveData(row.bonding_curve_address);
          if (bondingCurveData) {
            const progress = this.calculateProgress(bondingCurveData);
            console.log(`Current actual progress: ${progress.toFixed(2)}%`);
            
            if (Math.abs(progress - (row.bonding_curve_progress || 0)) > 1) {
              console.log(`Updating progress in database...`);
              await monitorService.updatePoolProgress(row.pool_id, progress);
            }
          }
        }
      } else {
        console.log("❌ No bonding curve address found for this token");
      }

    } catch (error) {
      console.error("Error scanning token:", error);
    }
  }
}

// Export for use in npm scripts
export default GraduatedTokenScanner;

// If run directly
if (require.main === module) {
  const scanner = new GraduatedTokenScanner();
  
  // Check if a specific token mint was provided
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0]) {
    // Scan specific token
    scanner.scanSpecificToken(args[0]).catch(console.error);
  } else {
    // Scan all tokens
    scanner.scanForGraduatedTokens().catch(console.error);
  }
}