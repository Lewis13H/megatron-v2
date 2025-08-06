import "dotenv/config";
import { monitorService } from "../../database";
import { getDbPool } from "../../database/connection";

async function addGraduatedPool(tokenMint: string, poolAddress: string, platform: 'raydium' | 'pumpswap') {
  console.log("\n" + "=".repeat(80));
  console.log("📝 ADDING GRADUATED POOL");
  console.log("=".repeat(80));
  console.log(`Token Mint: ${tokenMint}`);
  console.log(`Pool Address: ${poolAddress}`);
  console.log(`Platform: ${platform}`);
  console.log("=".repeat(80) + "\n");

  try {
    const pool = getDbPool();
    
    // Get token info
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

    // Check if pool already exists
    const poolQuery = `
      SELECT id, platform, status
      FROM pools
      WHERE pool_address = $1
    `;
    const poolResult = await pool.query(poolQuery, [poolAddress]);
    
    if (poolResult.rows.length > 0) {
      console.log("\n✅ Pool already exists in database");
      console.log(`Platform: ${poolResult.rows[0].platform}`);
      console.log(`Status: ${poolResult.rows[0].status}`);
      return;
    }

    // Mark token as graduated if not already
    if (!token.is_graduated) {
      console.log("\n📝 Marking token as graduated...");
      await monitorService.markTokenAsGraduated(token.id, null);
    }

    // Add the graduated pool
    console.log("\n📝 Adding graduated pool to database...");
    await monitorService.savePool({
      pool_address: poolAddress,
      token_id: token.id,
      platform: platform,
      creation_signature: poolAddress,
      creation_timestamp: new Date(),
      initial_virtual_sol_reserves: '0',
      initial_virtual_token_reserves: '0',
      initial_real_sol_reserves: '0',
      initial_real_token_reserves: '0',
      metadata: {
        initial_price: 0,
        initial_price_usd: 0,
        latest_price: 0,
        latest_price_usd: 0,
      }
    });

    console.log("\n✅ Successfully added graduated pool!");
    console.log(`\n🔗 View on Solscan: https://solscan.io/account/${poolAddress}`);
    
    if (platform === 'pumpswap') {
      console.log(`🔗 Trade on PumpSwap: https://pumpswap.com/token/${tokenMint}`);
    } else {
      console.log(`🔗 Trade on Raydium: https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint}`);
    }

  } catch (error) {
    console.error("\n❌ Error:", error);
  }
}

// If run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.log("Usage: npm run graduation:add-pool -- <tokenMint> <poolAddress> <platform>");
    console.log("Platform: 'raydium' or 'pumpswap'");
    console.log("\nExample:");
    console.log("npm run graduation:add-pool -- fBkzGbc1qsoJTA3SgvLCZv4J8rR8GRUm67tRizBpump ADvPt9f7yp87i3Uhfvg3GM3nnNs715fzDz46sZ8Zb44i pumpswap");
    process.exit(1);
  }

  const [tokenMint, poolAddress, platform] = args;
  
  if (platform !== 'raydium' && platform !== 'pumpswap') {
    console.error("❌ Platform must be 'raydium' or 'pumpswap'");
    process.exit(1);
  }

  addGraduatedPool(tokenMint, poolAddress, platform as 'raydium' | 'pumpswap')
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}