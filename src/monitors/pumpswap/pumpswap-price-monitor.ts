import "dotenv/config";
import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeRequestFilterTransactions
} from "@triton-one/yellowstone-grpc";
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { SolanaParser } from "@shyft-to/solana-transaction-parser";
import * as fs from "fs";
import * as path from "path";
import { TransactionFormatter } from "./utils/transaction-formatter";
import { SolanaEventParser } from "./utils/event-parser";
import { monitorService } from "../../database";

// PumpSwap AMM Program
const PUMPSWAP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

// Suppress parser warnings
const originalConsoleWarn = console.warn;
console.warn = (message?: any, ...optionalParams: any[]) => {
  if (
    typeof message === "string" &&
    message.includes("Parser does not matching the instruction args")
  ) {
    return;
  }
  originalConsoleWarn(message, ...optionalParams);
};

interface PriceUpdate {
  poolAddress: string;
  tokenMint: string;
  priceInSol: number;
  priceInUsd: number;
  solReserves: string;
  tokenReserves: string;
  volume24h?: number;
  lastUpdate: Date;
}

class PumpSwapPriceMonitor {
  private client: Client;
  private streams: Set<any> = new Set();
  private parser: SolanaParser;
  private txFormatter: TransactionFormatter;
  private eventParser: SolanaEventParser;
  private priceCache = new Map<string, PriceUpdate>();
  private PRICE_UPDATE_INTERVAL = 5000; // 5 seconds debounce

  constructor() {
    this.client = new Client(
      process.env.GRPC_URL!,
      process.env.X_TOKEN,
      undefined
    );
    
    this.txFormatter = new TransactionFormatter();
    
    // Load IDL
    const idlPath = path.join(__dirname, "idls", "pump_amm_0.1.0.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    this.parser = new SolanaParser([]);
    this.parser.addParserFromIdl(PUMPSWAP_AMM_PROGRAM, idl as Idl);
    
    this.eventParser = new SolanaEventParser([], console);
    this.eventParser.addParserFromIdl(PUMPSWAP_AMM_PROGRAM, idl as Idl);
  }

  async start() {
    console.log("\n" + "=".repeat(80));
    console.log("💹 PUMPSWAP PRICE MONITOR");
    console.log("=".repeat(80));
    console.log("📍 Tracking: Real-time price updates from swaps");
    console.log("🎯 Program: " + PUMPSWAP_AMM_PROGRAM);
    console.log("⏱️  Update Interval: " + (this.PRICE_UPDATE_INTERVAL / 1000) + " seconds");
    console.log("=".repeat(80) + "\n");

    // Start periodic price updates
    this.startPriceUpdateLoop();

    await this.monitorSwapTransactions();
  }

  private async monitorSwapTransactions() {
    const req: SubscribeRequest = {
      accounts: {},
      slots: {},
      transactions: {
        pumpswap_swaps: {
          vote: false,
          failed: false,
          signature: undefined,
          accountInclude: [PUMPSWAP_AMM_PROGRAM],
          accountExclude: [],
          accountRequired: []
        }
      },
      transactionsStatus: {},
      entry: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED
    };

    await this.subscribe(req, this.handleSwapTransaction.bind(this));
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

  private async handleSwapTransaction(data: any) {
    if (!data?.transaction) return;

    try {
      // Format transaction
      const txn = this.txFormatter.formTransactionFromJson(data, Date.now());
      
      // Parse events
      const events = this.eventParser.parseEvent(txn);

      if (events && events.length > 0) {
        for (const event of events) {
          if (event.name === "BuyEvent" || event.name === "SellEvent") {
            await this.extractPriceUpdate(event);
          }
        }
      }

    } catch (error) {
      // Suppress parsing errors
    }
  }

  private async extractPriceUpdate(event: any) {
    try {
      const eventData = event.data;
      const poolAddress = eventData.pool?.toString() || "";
      
      if (!poolAddress) return;

      // Calculate price from the swap
      const solAmount = Number(eventData.solAmount || 0) / 1e9;
      const tokenAmount = Number(eventData.tokenAmount || 0) / 1e6;
      const price = tokenAmount > 0 ? solAmount / tokenAmount : 0;

      // Get SOL price
      const solPrice = (await monitorService.getLatestSolPrice()) || 200;

      // Update cache
      const priceUpdate: PriceUpdate = {
        poolAddress,
        tokenMint: eventData.tokenMint?.toString() || "",
        priceInSol: price,
        priceInUsd: price * solPrice,
        solReserves: eventData.postSolReserves?.toString() || "0",
        tokenReserves: eventData.postTokenReserves?.toString() || "0",
        lastUpdate: new Date()
      };

      this.priceCache.set(poolAddress, priceUpdate);

      // Log price update
      const isBuy = event.name === "BuyEvent";
      console.log(`${isBuy ? '🟢' : '🔴'} ${poolAddress.slice(0, 8)}... Price: $${priceUpdate.priceInUsd.toFixed(6)} (${priceUpdate.priceInSol.toFixed(9)} SOL)`);

    } catch (error) {
      console.error("Error extracting price update:", error);
    }
  }

  private startPriceUpdateLoop() {
    setInterval(async () => {
      const updates = Array.from(this.priceCache.entries());
      
      for (const [poolAddress, priceUpdate] of updates) {
        try {
          // Only update if price is recent
          const age = Date.now() - priceUpdate.lastUpdate.getTime();
          if (age > this.PRICE_UPDATE_INTERVAL * 2) {
            this.priceCache.delete(poolAddress);
            continue;
          }

          // Get pool from database
          const pool = await monitorService.getPoolByAddress(poolAddress);
          if (!pool) continue;

          // Update pool reserves and price
          await monitorService.execute(
            `UPDATE pools 
             SET real_sol_reserves = $2,
                 real_token_reserves = $3,
                 latest_price = $4,
                 latest_price_usd = $5,
                 updated_at = NOW()
             WHERE id = $1`,
            [
              pool.id,
              priceUpdate.solReserves,
              priceUpdate.tokenReserves,
              priceUpdate.priceInSol,
              priceUpdate.priceInUsd
            ]
          );

          // Record price in time series
          await monitorService.recordPrice({
            pool_id: pool.id,
            price_sol: priceUpdate.priceInSol,
            price_usd: priceUpdate.priceInUsd,
            volume_sol: 0, // Volume tracked separately
            volume_usd: 0,
            timestamp: priceUpdate.lastUpdate
          });

          console.log(`💾 Updated price for ${poolAddress.slice(0, 8)}... to $${priceUpdate.priceInUsd.toFixed(6)}`);

        } catch (error) {
          console.error(`Error updating price for ${poolAddress}:`, error);
        }
      }
    }, this.PRICE_UPDATE_INTERVAL);
  }

  async stop() {
    console.log("Stopping PumpSwap Price Monitor...");
    for (const stream of this.streams) {
      stream.end();
    }
    this.streams.clear();
  }
}

// Export for use in npm scripts
export default PumpSwapPriceMonitor;

// If run directly
if (require.main === module) {
  const monitor = new PumpSwapPriceMonitor();
  
  process.on("SIGINT", async () => {
    await monitor.stop();
    process.exit(0);
  });

  monitor.start().catch(console.error);
}