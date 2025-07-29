import "dotenv/config";
import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeRequestFilterTransactions
} from "@triton-one/yellowstone-grpc";
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { SolanaParser } from "@shyft-to/solana-transaction-parser";
import bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";
// @ts-ignore - Raydium SDK types
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { TransactionFormatter } from "./utils/transaction-formatter";
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import { SolanaEventParser } from "./utils/event-parser";

// Program IDs
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const MIGRATION_ACCOUNT = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const PUMP_SWAP_AMM = "PumpkinsUmdZxR1XXkUHJnJjBFQfX3pnyM3KiR5Q1B1"; // Update with actual PumpSwap AMM ID

// Track graduation states
interface GraduationEvent {
  tokenMint: string;
  bondingCurve: string;
  graduationTx: string;
  targetAmm: "raydium" | "pumpswap" | "pumpfun";
  poolAddress?: string;
  timestamp: number;
  poolCreationTx?: string;
}

const graduationTracker = new Map<string, GraduationEvent>();

// Track seen pools to avoid duplicates
const seenPools = new Set<string>();
const POOL_CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

class GraduationMonitor {
  private client: Client;
  private streams: Set<any> = new Set();
  private txFormatter: TransactionFormatter;
  private pumpParser: SolanaParser;
  private eventParser: SolanaEventParser;

  constructor() {
    this.client = new Client(
      process.env.GRPC_URL!,
      process.env.X_TOKEN,
      undefined
    );
    
    this.txFormatter = new TransactionFormatter();
    
    // Load IDLs
    const pumpIdlPath = path.join(__dirname, "idls", "pump_0.1.0.json");
    if (fs.existsSync(pumpIdlPath)) {
      const pumpIdl = JSON.parse(fs.readFileSync(pumpIdlPath, "utf8"));
      this.pumpParser = new SolanaParser([]);
      this.pumpParser.addParserFromIdl(PUMP_PROGRAM_ID, pumpIdl as Idl);
      
      this.eventParser = new SolanaEventParser([], console);
      this.eventParser.addParserFromIdl(PUMP_PROGRAM_ID, pumpIdl as Idl);
    } else {
      // Initialize empty parsers if IDL not found
      this.pumpParser = new SolanaParser([]);
      this.eventParser = new SolanaEventParser([], console);
      console.warn("⚠️  Pump.fun IDL not found, some features may be limited");
    }
  }

  async start() {
    console.log("\n" + "=".repeat(80));
    console.log("🎓 PUMP.FUN GRADUATION MONITOR");
    console.log("=".repeat(80));
    console.log("📍 Tracking: Token graduations from Pump.fun to AMMs");
    console.log("🎯 Migration Account: " + MIGRATION_ACCOUNT);
    console.log("🏊 Target AMMs: Raydium, PumpSwap, Pump.fun AMM");
    console.log("🕐 Pool Filter: Only showing pools created in the last hour");
    console.log("🔍 Duplicate Filter: Each pool shown only once");
    console.log("=".repeat(80) + "\n");
    
    // Periodic cleanup of seen pools cache (every 2 hours)
    setInterval(() => {
      const oldSize = seenPools.size;
      seenPools.clear();
      console.log(`\n🧹 Cleared pool cache (was tracking ${oldSize} pools)\n`);
    }, 2 * 60 * 60 * 1000);
    
    // Start monitoring streams in parallel
    await Promise.all([
      this.monitorMigrationTransactions(),
      this.monitorRaydiumPools(),
      // Add PumpSwap monitoring when available
    ]);
  }

  private async monitorMigrationTransactions() {
    const req: SubscribeRequest = {
      accounts: {},
      slots: {},
      transactions: {
        migration: {
          vote: false,
          failed: false,
          signature: undefined,
          accountInclude: [MIGRATION_ACCOUNT],
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

    await this.subscribe(req, this.handleMigrationTransaction.bind(this));
  }

  private async monitorRaydiumPools() {
    const req: SubscribeRequest = {
      slots: {},
      accounts: {
        raydium: {
          account: [],
          filters: [
            {
              memcmp: {
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("quoteMint").toString(),
                base58: "So11111111111111111111111111111111111111112"
              }
            },
            {
              memcmp: {
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("marketProgramId").toString(),
                base58: "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX"
              }
            }
          ],
          owner: [RAYDIUM_AMM_V4]
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

    await this.subscribe(req, this.handleRaydiumPoolCreation.bind(this));
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

  private async handleMigrationTransaction(data: any) {
    if (!data?.transaction) return;

    try {
      const txn = this.txFormatter.formTransactionFromJson(data.transaction, Date.now());
      const signature = txn.transaction.signatures[0];

      // Parse transaction to look for graduation
      const parsedIxs = await this.parseTransaction(txn);
      if (!parsedIxs || parsedIxs.length === 0) return;

      // Look for initialize2 instruction (Raydium pool creation)
      const hasInitialize2 = parsedIxs.some((ix: any) => 
        ix.name === "initialize2" || ix.name === "Initialize2"
      );

      if (hasInitialize2) {
        // Extract token mint from transaction
        const tokenMint = await this.extractTokenMintFromTx(txn, parsedIxs);
        if (!tokenMint) return;

        // Determine target AMM
        const targetAmm = this.determineTargetAmm(txn);
        
        const event: GraduationEvent = {
          tokenMint,
          bondingCurve: "", // Would need to extract from tx
          graduationTx: signature,
          targetAmm,
          timestamp: Date.now()
        };

        graduationTracker.set(tokenMint, event);

        console.log("\n" + "🎉".repeat(40));
        console.log("🎓 GRADUATION DETECTED!");
        console.log("─".repeat(80));
        console.log(`⏰ Time: ${new Date().toLocaleString()}`);
        console.log(`🪙 Token Mint: ${tokenMint}`);
        console.log(`📝 Transaction: https://solscan.io/tx/${signature}`);
        console.log(`🎯 Target AMM: ${targetAmm.toUpperCase()}`);
        console.log(`🔗 Pump.fun: https://pump.fun/coin/${tokenMint}`);
        console.log("🎉".repeat(40) + "\n");
      }
    } catch (error) {
      // Suppress parsing errors
    }
  }

  private handleRaydiumPoolCreation(data: any) {
    if (!data?.account) return;

    try {
      const poolInfo = LIQUIDITY_STATE_LAYOUT_V4.decode(
        Buffer.from(data.account.account.data, "base64")
      );

      const poolAddress = bs58.encode(data.account.account.pubkey);
      const baseMint = poolInfo.baseMint.toString();
      const quoteMint = poolInfo.quoteMint.toString();
      const openTime = poolInfo.poolOpenTime.toNumber() * 1000;
      
      // Skip if we've already seen this pool
      if (seenPools.has(poolAddress)) {
        return;
      }

      // Check if pool is already open (filter out future pools)
      if (openTime > Date.now()) {
        return; // Skip future pools silently
      }
      
      // Filter out old pools (only show pools created in the last hour)
      const poolAge = Date.now() - openTime;
      if (poolAge > POOL_CACHE_DURATION) {
        return; // Skip old pools silently
      }

      // Mark this pool as seen
      seenPools.add(poolAddress);

      // Check if this is a graduated pump.fun token
      const event = graduationTracker.get(baseMint);
      if (event) {
        event.poolAddress = poolAddress;
        graduationTracker.set(baseMint, event);

        console.log("\n" + "🏊".repeat(40));
        console.log("🏊 RAYDIUM POOL CREATED!");
        console.log("─".repeat(80));
        console.log(`⏰ Time: ${new Date().toLocaleString()}`);
        console.log(`🪙 Token Mint: ${baseMint}`);
        console.log(`💧 Pool Address: ${poolAddress}`);
        console.log(`💱 Pair: ${baseMint} / SOL`);
        console.log(`📅 Pool Open Time: ${new Date(openTime).toLocaleString()}`);
        console.log(`🔗 Raydium: https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${baseMint}`);
        console.log("─".repeat(80));
        console.log(`✅ GRADUATION COMPLETE!`);
        console.log(`⏱️  Total Time: ${((Date.now() - event.timestamp) / 1000).toFixed(2)}s`);
        console.log("🏊".repeat(40) + "\n");
      } else {
        // New pool for non-graduated token
        const ageMinutes = Math.floor(poolAge / 60000);
        console.log(`\n🏊 New Raydium Pool Created (${ageMinutes}m ago)`);
        console.log(`   Token Mint: ${baseMint}`);
        console.log(`   Pool Address: ${poolAddress}`);
        console.log(`   Quote: SOL`);
        console.log(`   Open Time: ${new Date(openTime).toLocaleString()}`);
      }
    } catch (error) {
      // Not a valid Raydium pool account
    }
  }

  private async parseTransaction(tx: VersionedTransactionResponse): Promise<any[] | null> {
    if (tx.meta?.err) return null;
    
    try {
      // Try to parse with our parser
      const parsedIxs = this.pumpParser.parseTransactionData(
        tx.transaction.message,
        tx.meta?.loadedAddresses || undefined
      );

      return parsedIxs;
    } catch (err) {
      // If parsing fails, return empty array
      return [];
    }
  }

  private determineTargetAmm(txn: VersionedTransactionResponse): "raydium" | "pumpswap" | "pumpfun" {
    // Get account keys based on message version
    const message = txn.transaction.message;
    let accountKeys: string[] = [];
    
    if ('accountKeys' in message) {
      // Legacy message
      accountKeys = (message as any).accountKeys.map((key: any) => key.toString());
    } else if ('staticAccountKeys' in message) {
      // Versioned message
      accountKeys = (message as any).staticAccountKeys.map((key: any) => key.toString());
    }
    
    const accountStrings = accountKeys;
    
    if (accountStrings.includes(RAYDIUM_AMM_V4)) {
      return "raydium";
    } else if (accountStrings.includes(PUMP_SWAP_AMM)) {
      return "pumpswap";
    } else {
      return "pumpfun";
    }
  }

  private async extractTokenMintFromTx(txn: VersionedTransactionResponse, parsedIxs: any[]): Promise<string | null> {
    try {
      // Look for token mint in parsed instructions
      for (const ix of parsedIxs) {
        if (ix.args?.mint) {
          return ix.args.mint.toString();
        }
        // Check accounts for mint
        const mintAccount = ix.accounts?.find((acc: any) => 
          acc.name === "mint" || acc.name === "tokenMint" || acc.name === "baseMint"
        );
        if (mintAccount?.pubkey) {
          return mintAccount.pubkey.toString();
        }
      }

      // Fallback: check transaction accounts
      // Typically the token mint is one of the first accounts
      const message = txn.transaction.message;
      let accounts: any[] = [];
      
      if ('accountKeys' in message) {
        accounts = (message as any).accountKeys;
      } else if ('staticAccountKeys' in message) {
        accounts = (message as any).staticAccountKeys;
      }
      
      if (accounts.length > 5) {
        // Skip common program IDs and look for potential mint
        for (let i = 0; i < Math.min(10, accounts.length); i++) {
          const account = accounts[i].toString();
          if (!this.isSystemProgram(account)) {
            return account;
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private isSystemProgram(address: string): boolean {
    const systemPrograms = [
      "11111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "SysvarRent111111111111111111111111111111111",
      PUMP_PROGRAM_ID,
      MIGRATION_ACCOUNT,
      RAYDIUM_AMM_V4,
      PUMP_SWAP_AMM
    ];
    return systemPrograms.includes(address);
  }

  async stop() {
    console.log("Stopping Graduation Monitor...");
    for (const stream of this.streams) {
      stream.end();
    }
    this.streams.clear();
  }
}

// Export for use in npm scripts
export default GraduationMonitor;

// If run directly
if (require.main === module) {
  const monitor = new GraduationMonitor();
  
  process.on("SIGINT", async () => {
    await monitor.stop();
    process.exit(0);
  });

  monitor.start().catch(console.error);
}