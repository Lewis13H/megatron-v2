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

class PumpSwapTransactionMonitor {
  private client: Client;
  private streams: Set<any> = new Set();
  private parser: SolanaParser;
  private txFormatter: TransactionFormatter;
  private eventParser: SolanaEventParser;

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
    console.log("📝 PUMPSWAP TRANSACTION MONITOR");
    console.log("=".repeat(80));
    console.log("📍 Tracking: All swap transactions on PumpSwap AMM");
    console.log("🎯 Program: " + PUMPSWAP_AMM_PROGRAM);
    console.log("💾 Saving: Transaction history for analysis");
    console.log("=".repeat(80) + "\n");

    await this.monitorTransactions();
  }

  private async monitorTransactions() {
    const req: SubscribeRequest = {
      accounts: {},
      slots: {},
      transactions: {
        pumpswap_txs: {
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

    await this.subscribe(req, this.handleTransaction.bind(this));
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

  private async handleTransaction(data: any) {
    if (!data?.transaction) return;

    try {
      // Format transaction
      const txn = this.txFormatter.formTransactionFromJson(data, Date.now());
      const signature = txn.transaction.signatures[0];

      // Parse instructions
      const parsedIxs = this.parser.parseTransactionData(
        txn.transaction.message,
        txn.meta?.loadedAddresses || undefined
      );

      // Parse events
      const events = this.eventParser.parseEvent(txn);

      // Count buy/sell events
      let buyCount = 0;
      let sellCount = 0;
      let totalSolVolume = 0;

      if (events && events.length > 0) {
        for (const event of events) {
          if (event.name === "BuyEvent") {
            buyCount++;
            totalSolVolume += Number(event.data.solAmount || 0) / 1e9;
          } else if (event.name === "SellEvent") {
            sellCount++;
            totalSolVolume += Number(event.data.solAmount || 0) / 1e9;
          }
        }
      }

      // Log transaction summary
      const timestamp = new Date().toISOString();
      console.log(`\n${timestamp} : PumpSwap transaction https://solscan.io/tx/${signature}`);
      console.log(`💹 Events: ${buyCount} buys, ${sellCount} sells`);
      console.log(`💰 Volume: ${totalSolVolume.toFixed(4)} SOL`);
      console.log("─".repeat(100));

      // Process and save events
      if (events && events.length > 0) {
        for (const event of events) {
          if (event.name === "BuyEvent" || event.name === "SellEvent") {
            await this.processTradingEvent(event, txn, signature);
          }
        }
      }

    } catch (error) {
      // Suppress parsing errors
    }
  }

  private async processTradingEvent(event: any, txn: VersionedTransactionResponse, signature: string) {
    try {
      const isBuy = event.name === "BuyEvent";
      const eventData = event.data;
      
      // Extract pool and user from event or transaction
      const poolAddress = eventData.pool?.toString() || "";
      const userAddress = eventData.user?.toString() || "";
      const solAmount = Number(eventData.solAmount || 0) / 1e9;
      const tokenAmount = Number(eventData.tokenAmount || 0) / 1e6;
      const price = tokenAmount > 0 ? solAmount / tokenAmount : 0;

      // Get pool from database
      const pool = await monitorService.getPoolByAddress(poolAddress);
      if (!pool) {
        console.log(`⚠️  Pool not in database: ${poolAddress.slice(0, 8)}... (graduated token not tracked)`);
        return;
      }

      // Get latest SOL price
      const solPrice = (await monitorService.getLatestSolPrice()) || 200;

      // Save transaction
      await monitorService.saveTransaction({
        signature,
        token_id: pool.token_id,
        pool_id: pool.id,
        block_time: new Date(txn.blockTime! * 1000),
        slot: txn.slot,
        type: isBuy ? 'buy' : 'sell',
        user_address: userAddress,
        sol_amount: solAmount.toString(),
        token_amount: tokenAmount.toString(),
        price_per_token: price,
        post_tx_sol_reserves: eventData.postSolReserves?.toString() || '0',
        post_tx_token_reserves: eventData.postTokenReserves?.toString() || '0',
        metadata: {
          program: 'pumpswap',
          instructionName: event.name,
          priceUsd: price * solPrice
        }
      });

      console.log(`💾 Saved ${isBuy ? 'BUY' : 'SELL'} transaction for pool ${poolAddress.slice(0, 8)}...`);

    } catch (error) {
      console.error("Error processing trading event:", error);
    }
  }

  async stop() {
    console.log("Stopping PumpSwap Transaction Monitor...");
    for (const stream of this.streams) {
      stream.end();
    }
    this.streams.clear();
  }
}

// Export for use in npm scripts
export default PumpSwapTransactionMonitor;

// If run directly
if (require.main === module) {
  const monitor = new PumpSwapTransactionMonitor();
  
  process.on("SIGINT", async () => {
    await monitor.stop();
    process.exit(0);
  });

  monitor.start().catch(console.error);
}