import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
// @ts-ignore - Raydium SDK types
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { monitorService } from "../../database";
import { getDbPool } from "../../database/connection";

class GraduatedPoolFinder {
  private connection: Connection;
  private RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
  private RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
  private SOL_MINT = "So11111111111111111111111111111111111111112";

  constructor() {
    this.connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
    );
  }

  async findPoolsForGraduatedTokens() {
    console.log("\n" + "=".repeat(80));
    console.log("🔍 FINDING RAYDIUM POOLS FOR GRADUATED TOKENS");
    console.log("=".repeat(80));
    console.log("📍 This will search for Raydium pools of graduated Pump.fun tokens");
    console.log("=".repeat(80) + "\n");

    try {
      // Get all graduated tokens without Raydium pools
      const pool = getDbPool();
      const query = `
        SELECT DISTINCT
          t.id as token_id,
          t.mint_address,
          t.symbol,
          t.name,
          t.graduation_timestamp
        FROM tokens t
        WHERE t.platform = 'pumpfun'
          AND t.is_graduated = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM pools p 
            WHERE p.token_id = t.id 
            AND p.platform IN ('raydium', 'raydium_cpmm')
          )
        ORDER BY t.graduation_timestamp DESC
      `;

      const result = await pool.query(query);
      console.log(`Found ${result.rows.length} graduated tokens without Raydium pools\n`);

      let foundCount = 0;
      let errorCount = 0;

      for (const row of result.rows) {
        try {
          console.log(`\nChecking ${row.symbol} (${row.mint_address})...`);
          
          // Search for Raydium V4 pools
          const v4Pool = await this.findRaydiumV4Pool(row.mint_address);
          if (v4Pool) {
            console.log(`✅ Found Raydium V4 pool: ${v4Pool.poolAddress}`);
            await this.savePool(row.token_id, v4Pool, 'raydium');
            foundCount++;
            continue;
          }

          // TODO: Add CPMM pool search when needed
          console.log(`❌ No Raydium pool found`);

        } catch (error) {
          console.error(`Error checking token ${row.symbol}:`, error);
          errorCount++;
        }

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log("\n" + "=".repeat(80));
      console.log("📊 SEARCH COMPLETE");
      console.log(`✅ Pools found: ${foundCount}`);
      console.log(`❌ Errors: ${errorCount}`);
      console.log(`📈 Tokens checked: ${result.rows.length}`);
      console.log("=".repeat(80) + "\n");

    } catch (error) {
      console.error("Fatal error:", error);
    }
  }

  async findPoolForSpecificToken(tokenMint: string) {
    console.log(`\n🔍 Searching for Raydium pool for token: ${tokenMint}`);
    
    try {
      // Get token info from database
      const pool = getDbPool();
      const tokenQuery = `
        SELECT id, symbol, name, is_graduated
        FROM tokens
        WHERE mint_address = $1
      `;
      const tokenResult = await pool.query(tokenQuery, [tokenMint]);
      
      if (tokenResult.rows.length === 0) {
        console.log("❌ Token not found in database");
        return;
      }

      const token = tokenResult.rows[0];
      console.log(`Token: ${token.symbol} (${token.name})`);
      console.log(`Graduated: ${token.is_graduated ? 'Yes' : 'No'}`);

      // Search for Raydium V4 pool
      const v4Pool = await this.findRaydiumV4Pool(tokenMint);
      if (v4Pool) {
        console.log(`\n✅ FOUND RAYDIUM V4 POOL!`);
        console.log(`Pool Address: ${v4Pool.poolAddress}`);
        console.log(`Open Time: ${new Date(v4Pool.openTime).toLocaleString()}`);
        console.log(`LP Supply: ${v4Pool.lpSupply}`);
        console.log(`Base Decimals: ${v4Pool.baseDecimal}`);
        console.log(`Quote Decimals: ${v4Pool.quoteDecimal}`);
        console.log(`\n🔗 View on Solscan: https://solscan.io/account/${v4Pool.poolAddress}`);
        console.log(`🔗 Trade on Raydium: https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint}`);

        // Check if pool already exists in database
        const poolQuery = `
          SELECT id FROM pools WHERE pool_address = $1
        `;
        const poolResult = await pool.query(poolQuery, [v4Pool.poolAddress]);
        
        if (poolResult.rows.length === 0) {
          console.log("\n💾 Saving pool to database...");
          await this.savePool(token.id, v4Pool, 'raydium');
          console.log("✅ Pool saved successfully!");
        } else {
          console.log("\n✅ Pool already exists in database");
        }
      } else {
        console.log("\n❌ No Raydium pool found for this token");
      }

    } catch (error) {
      console.error("Error:", error);
    }
  }

  async findRaydiumV4Pool(tokenMint: string): Promise<any | null> {
    try {
      // Get all accounts owned by Raydium AMM V4
      const accounts = await this.connection.getProgramAccounts(
        new PublicKey(this.RAYDIUM_AMM_V4),
        {
          filters: [
            {
              memcmp: {
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('baseMint'),
                bytes: tokenMint,
              },
            },
            {
              memcmp: {
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
                bytes: this.SOL_MINT,
              },
            },
          ],
        }
      );

      if (accounts.length === 0) {
        // Try with token as quote mint
        const reverseAccounts = await this.connection.getProgramAccounts(
          new PublicKey(this.RAYDIUM_AMM_V4),
          {
            filters: [
              {
                memcmp: {
                  offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
                  bytes: tokenMint,
                },
              },
              {
                memcmp: {
                  offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('baseMint'),
                  bytes: this.SOL_MINT,
                },
              },
            ],
          }
        );
        
        if (reverseAccounts.length > 0) {
          accounts.push(...reverseAccounts);
        }
      }

      if (accounts.length === 0) {
        return null;
      }

      // Parse the first pool found
      const poolAccount = accounts[0];
      const poolInfo = LIQUIDITY_STATE_LAYOUT_V4.decode(poolAccount.account.data);

      return {
        poolAddress: poolAccount.pubkey.toString(),
        baseMint: poolInfo.baseMint.toString(),
        quoteMint: poolInfo.quoteMint.toString(),
        lpMint: poolInfo.lpMint.toString(),
        baseDecimal: poolInfo.baseDecimal,
        quoteDecimal: poolInfo.quoteDecimal,
        lpSupply: poolInfo.lpSupply.toString(),
        baseVault: poolInfo.baseVault.toString(),
        quoteVault: poolInfo.quoteVault.toString(),
        openTime: poolInfo.poolOpenTime.toNumber() * 1000,
        status: poolInfo.status,
      };
    } catch (error) {
      console.error("Error finding Raydium pool:", error);
      return null;
    }
  }

  async savePool(tokenId: string, poolData: any, platform: string) {
    try {
      await monitorService.savePool({
        pool_address: poolData.poolAddress,
        token_id: tokenId,
        base_mint: poolData.baseMint,
        quote_mint: poolData.quoteMint,
        platform: platform,
        pool_type: 'graduated',
        lp_mint: poolData.lpMint,
        base_vault: poolData.baseVault,
        quote_vault: poolData.quoteVault,
        virtual_sol_reserves: '0',
        virtual_token_reserves: '0',
        real_sol_reserves: '0',
        real_token_reserves: '0',
        bonding_curve_progress: null,
        status: 'active',
        initial_price: 0,
        initial_price_usd: 0,
        latest_price: 0,
        latest_price_usd: 0,
      });
    } catch (error) {
      console.error("Error saving pool:", error);
      throw error;
    }
  }

  async checkSpecificPool(poolAddress: string) {
    console.log(`\n🔍 Checking pool: ${poolAddress}`);
    
    try {
      const poolPubkey = new PublicKey(poolAddress);
      const accountInfo = await this.connection.getAccountInfo(poolPubkey);
      
      if (!accountInfo) {
        console.log("❌ Account not found");
        return;
      }

      console.log(`Owner: ${accountInfo.owner.toString()}`);
      console.log(`Data Length: ${accountInfo.data.length}`);
      console.log(`Lamports: ${accountInfo.lamports}`);

      if (accountInfo.owner.toString() === this.RAYDIUM_AMM_V4) {
        console.log("\n✅ This is a Raydium V4 AMM pool!");
        
        const poolInfo = LIQUIDITY_STATE_LAYOUT_V4.decode(accountInfo.data);
        console.log(`\nPool Details:`);
        console.log(`Base Mint: ${poolInfo.baseMint.toString()}`);
        console.log(`Quote Mint: ${poolInfo.quoteMint.toString()}`);
        console.log(`LP Mint: ${poolInfo.lpMint.toString()}`);
        console.log(`Open Time: ${new Date(poolInfo.poolOpenTime.toNumber() * 1000).toLocaleString()}`);
        console.log(`Status: ${poolInfo.status}`);
        
        // Check which token is the base
        if (poolInfo.quoteMint.toString() === this.SOL_MINT) {
          console.log(`\n🪙 Token: ${poolInfo.baseMint.toString()}`);
          console.log(`💧 Paired with: SOL`);
        } else if (poolInfo.baseMint.toString() === this.SOL_MINT) {
          console.log(`\n🪙 Token: ${poolInfo.quoteMint.toString()}`);
          console.log(`💧 Paired with: SOL`);
        }
      } else {
        console.log("\n❓ Not a Raydium V4 pool");
      }

    } catch (error) {
      console.error("Error checking pool:", error);
    }
  }
}

// Export for use
export default GraduatedPoolFinder;

// If run directly
if (require.main === module) {
  const finder = new GraduatedPoolFinder();
  
  const args = process.argv.slice(2);
  if (args.length > 0) {
    if (args[0].length === 44 && args[0] !== args[0].toLowerCase()) {
      // Looks like a pool address
      finder.checkSpecificPool(args[0]).catch(console.error);
    } else {
      // Looks like a token mint
      finder.findPoolForSpecificToken(args[0]).catch(console.error);
    }
  } else {
    // Find all pools
    finder.findPoolsForGraduatedTokens().catch(console.error);
  }
}