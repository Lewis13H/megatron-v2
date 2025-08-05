import "dotenv/config";
import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeRequestFilterAccounts
} from "@triton-one/yellowstone-grpc";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { struct, publicKey, u64, u8 } from "@coral-xyz/borsh";
import { monitorService } from "../../database";

// PumpSwap AMM Program
const PUMPSWAP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Pool account structure (simplified - adjust based on actual layout)
const poolStructure = struct([
  u8("discriminator"),
  publicKey("tokenMint"),
  publicKey("solMint"),
  u64("tokenReserves"),
  u64("solReserves"),
  u64("lpSupply"),
  publicKey("lpMint"),
  u8("status"),
  u64("createdAt"),
]);

class PumpSwapPoolMonitor {
  private client: Client;
  private streams: Set<any> = new Set();
  private seenPools = new Set<string>();

  constructor() {
    this.client = new Client(
      process.env.GRPC_URL!,
      process.env.X_TOKEN,
      undefined
    );
  }

  async start() {
    console.log("\n" + "=".repeat(80));
    console.log("🏊 PUMPSWAP POOL MONITOR");
    console.log("=".repeat(80));
    console.log("📍 Tracking: New pool creation for graduated tokens");
    console.log("🎯 Program: " + PUMPSWAP_AMM_PROGRAM);
    console.log("=".repeat(80) + "\n");

    await this.monitorPoolAccounts();
  }

  private async monitorPoolAccounts() {
    const req: SubscribeRequest = {
      slots: {},
      accounts: {
        pumpswap_pools: {
          account: [],
          owner: [PUMPSWAP_AMM_PROGRAM],
          filters: []
        }
      },
      transactions: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
      entry: {},
      transactionsStatus: {}
    };

    await this.subscribe(req, this.handlePoolAccount.bind(this));
  }

  private async subscribe(req: SubscribeRequest, handler: (data: any) => void) {
    while (true) {
      try {
        await this.handleStream(req, handler);
      } catch (error) {
        console.error("Stream error, restarting in 1 second...", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleStream(req: SubscribeRequest, handler: (data: any) => void) {
    const stream = await this.client.subscribe();
    this.streams.add(stream);

    const streamClosed = new Promise<void>((resolve, reject) => {
      stream.on("error", (error) => {
        console.error("Stream error:", error);
        reject(error);
        stream.end();
      });
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
    });

    stream.on("data", async (data) => {
      try {
        await handler(data);
      } catch (error) {
        console.error("Handler error:", error);
      }
    });

    await new Promise<void>((resolve, reject) => {
      stream.write(req, (err: any) => {
        if (err === null || err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      });
    });

    await streamClosed;
    this.streams.delete(stream);
  }

  private async handlePoolAccount(data: any) {
    if (!data?.account) return;

    try {
      const poolAddress = bs58.encode(data.account.account.pubkey);
      
      // Skip if we've already seen this pool
      if (this.seenPools.has(poolAddress)) {
        return;
      }
      this.seenPools.add(poolAddress);

      // Try to decode pool data
      try {
        const poolData = poolStructure.decode(
          Buffer.from(data.account.account.data, "base64")
        );

        const tokenMint = poolData.tokenMint.toString();
        const solReserves = Number(poolData.solReserves) / 1e9;
        const tokenReserves = Number(poolData.tokenReserves) / 1e6; // Assuming 6 decimals
        const createdAt = new Date(Number(poolData.createdAt) * 1000);

        console.log("\n" + "🆕".repeat(40));
        console.log("🏊 NEW PUMPSWAP POOL DETECTED!");
        console.log("─".repeat(80));
        console.log(`⏰ Time: ${new Date().toLocaleString()}`);
        console.log(`💧 Pool Address: ${poolAddress}`);
        console.log(`🪙 Token Mint: ${tokenMint}`);
        console.log(`💎 SOL Reserves: ${solReserves.toFixed(4)} SOL`);
        console.log(`🪙 Token Reserves: ${tokenReserves.toFixed(0)}`);
        console.log(`📅 Created: ${createdAt.toLocaleString()}`);
        console.log(`🔗 Solscan: https://solscan.io/account/${poolAddress}`);
        console.log("🆕".repeat(40) + "\n");

        // Save pool to database
        await this.saveNewPool(poolAddress, tokenMint, poolData);

      } catch (decodeError) {
        // If we can't decode, it might be a different account type
        console.log(`📊 PumpSwap account update: ${poolAddress.slice(0, 8)}...`);
      }

    } catch (error) {
      console.error("Error processing pool account:", error);
    }
  }

  private async saveNewPool(poolAddress: string, tokenMint: string, poolData: any) {
    try {
      // Check if token exists in database
      const token = await monitorService.getTokenByMint(tokenMint);
      if (!token) {
        console.log(`⚠️  Token not found in database: ${tokenMint}`);
        return;
      }

      // Check if pool already exists
      const existingPool = await monitorService.getPoolByAddress(poolAddress);
      if (existingPool) {
        console.log(`✅ Pool already exists in database`);
        return;
      }

      // Calculate initial price
      const solReserves = Number(poolData.solReserves) / 1e9;
      const tokenReserves = Number(poolData.tokenReserves) / 1e6;
      const initialPrice = tokenReserves > 0 ? solReserves / tokenReserves : 0;

      // Save new pool
      await monitorService.savePool({
        pool_address: poolAddress,
        token_id: token.id,
        base_mint: tokenMint,
        quote_mint: SOL_MINT,
        platform: 'pumpswap',
        pool_type: 'graduated',
        status: 'active',
        lp_mint: poolData.lpMint.toString(),
        virtual_sol_reserves: '0',
        virtual_token_reserves: '0',
        real_sol_reserves: poolData.solReserves.toString(),
        real_token_reserves: poolData.tokenReserves.toString(),
        bonding_curve_progress: null,
        initial_price: initialPrice,
        initial_price_usd: initialPrice * 200, // Approximate SOL price
        latest_price: initialPrice,
        latest_price_usd: initialPrice * 200,
      });

      console.log(`💾 Saved new PumpSwap pool for ${token.symbol}`);

    } catch (error) {
      console.error("Error saving pool:", error);
    }
  }

  async stop() {
    console.log("Stopping PumpSwap Pool Monitor...");
    for (const stream of this.streams) {
      stream.end();
    }
    this.streams.clear();
  }
}

// Export for use in npm scripts
export default PumpSwapPoolMonitor;

// If run directly
if (require.main === module) {
  const monitor = new PumpSwapPoolMonitor();
  
  process.on("SIGINT", async () => {
    await monitor.stop();
    process.exit(0);
  });

  monitor.start().catch(console.error);
}