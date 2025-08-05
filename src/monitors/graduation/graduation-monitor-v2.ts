import "dotenv/config";
import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeRequestFilterTransactions,
  SubscribeRequestFilterAccounts
} from "@triton-one/yellowstone-grpc";
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { SolanaParser } from "@shyft-to/solana-transaction-parser";
import bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";
// @ts-ignore - Raydium SDK types
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { struct, bool, u64 } from "@coral-xyz/borsh";
import { monitorService } from "../../database";
import { TransactionFormatter } from "./utils/transaction-formatter";
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import { SolanaEventParser } from "./utils/event-parser";

// Program IDs
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const MIGRATION_ACCOUNT = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const PUMP_SWAP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"; // PumpSwap AMM program

// Bonding curve account structure (from Shyft example)
const bondingCurveStructure = struct([
  u64("discriminator"),
  u64("virtualTokenReserves"),
  u64("virtualSolReserves"),
  u64("realTokenReserves"),
  u64("realSolReserves"),
  u64("tokenTotalSupply"),
  bool("complete"),
]);

// Track graduation states
interface GraduationEvent {
  tokenMint: string;
  bondingCurve: string;
  bondingCurveComplete: boolean;
  graduationTx?: string;
  targetAmm?: "raydium" | "pumpswap" | "pumpfun";
  poolAddress?: string;
  timestamp: number;
  poolCreationTx?: string;
}

const graduationTracker = new Map<string, GraduationEvent>();
const bondingCurveToMint = new Map<string, string>();

// Track seen pools to avoid duplicates
const seenPools = new Set<string>();
const seenBondingCurves = new Set<string>();
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
    console.log("🎓 PUMP.FUN GRADUATION MONITOR V2");
    console.log("=".repeat(80));
    console.log("📍 Tracking:");
    console.log("   - Pump.fun bonding curve completion (complete = true)");
    console.log("   - Graduated token pool creation on Raydium/PumpSwap");
    console.log("   - Post-graduation price monitoring");
    console.log("🎯 Migration Account: " + MIGRATION_ACCOUNT);
    console.log("🏊 Target AMMs: Raydium V4, Raydium CPMM, PumpSwap");
    console.log("=".repeat(80) + "\n");
    
    // Periodic cleanup of seen pools cache (every 2 hours)
    setInterval(() => {
      const oldSize = seenPools.size;
      seenPools.clear();
      seenBondingCurves.clear();
      console.log(`\n🧹 Cleared cache (was tracking ${oldSize} pools)\n`);
    }, 2 * 60 * 60 * 1000);
    
    // Start monitoring streams in parallel
    await Promise.all([
      this.monitorBondingCurveCompletion(),
      this.monitorMigrationTransactions(),
      this.monitorRaydiumPools(),
      // Add PumpSwap monitoring when available
    ]);
  }

  private async monitorBondingCurveCompletion() {
    const req: SubscribeRequest = {
      slots: {},
      accounts: {
        pumpfun: {
          account: [],
          filters: [
            {
              memcmp: {
                offset: bondingCurveStructure.offsetOf('complete').toString(),
                bytes: Uint8Array.from([1]) // Filter for complete = true
              }
            }
          ],
          owner: [PUMP_PROGRAM_ID]
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

    await this.subscribe(req, this.handleBondingCurveCompletion.bind(this));
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
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint').toString(),
                base58: "So11111111111111111111111111111111111111112"
              }
            },
            {
              memcmp: {
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId').toString(),
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

  private async handleBondingCurveCompletion(data: any) {
    if (!data?.account) return;

    try {
      const bondingCurveAddress = bs58.encode(data.account.account.pubkey);
      
      // Skip if we've already seen this bonding curve
      if (seenBondingCurves.has(bondingCurveAddress)) {
        return;
      }
      seenBondingCurves.add(bondingCurveAddress);

      // Decode bonding curve data
      const bondingCurveData = bondingCurveStructure.decode(
        Buffer.from(data.account.account.data, "base64")
      );

      if (bondingCurveData.complete) {
        // Get token mint from bonding curve account
        // In Pump.fun, the bonding curve PDA is derived from the token mint
        // We need to extract the mint from the account data or use a reverse lookup
        
        // For now, we'll wait for the migration transaction to get the full details
        console.log("\n" + "✅".repeat(40));
        console.log("✅ BONDING CURVE COMPLETED!");
        console.log("─".repeat(80));
        console.log(`⏰ Time: ${new Date().toLocaleString()}`);
        console.log(`📊 Bonding Curve: ${bondingCurveAddress}`);
        console.log(`💧 Final SOL Reserves: ${(Number(bondingCurveData.virtualSolReserves) / 1e9).toFixed(4)} SOL`);
        console.log(`🪙 Final Token Reserves: ${(Number(bondingCurveData.virtualTokenReserves) / 1e6).toFixed(0)}`);
        console.log(`✨ Status: READY FOR GRADUATION`);
        console.log("✅".repeat(40) + "\n");

        // Update database - mark bonding curve as 100% complete
        try {
          const pool = await monitorService.getPoolByAddress(bondingCurveAddress);
          if (pool) {
            await monitorService.updatePoolProgress(pool.id, 100.00);
            await monitorService.updatePoolStatus(pool.id, 'graduated');
            
            // Mark token as graduated
            if (pool.token_id) {
              await monitorService.markTokenAsGraduated(pool.token_id, null);
            }
          }
        } catch (error) {
          console.error("Error updating database:", error);
        }
      }
    } catch (error) {
      console.error("Error processing bonding curve account:", error);
    }
  }

  private async handleMigrationTransaction(data: any) {
    if (!data?.transaction) return;

    try {
      const txn = this.txFormatter.formTransactionFromJson(data.transaction, Date.now());
      const signature = txn.transaction.signatures[0];

      // Parse transaction to look for graduation details
      const parsedIxs = await this.parseTransaction(txn);
      if (!parsedIxs || parsedIxs.length === 0) return;

      // Extract token mint and bonding curve from transaction
      const tokenMint = await this.extractTokenMintFromTx(txn, parsedIxs);
      const bondingCurve = await this.extractBondingCurveFromTx(txn, parsedIxs);
      
      if (!tokenMint) return;

      // Determine target AMM
      const targetAmm = this.determineTargetAmm(txn);
      
      const event: GraduationEvent = {
        tokenMint,
        bondingCurve: bondingCurve || "",
        bondingCurveComplete: true,
        graduationTx: signature,
        targetAmm,
        timestamp: Date.now()
      };

      graduationTracker.set(tokenMint, event);
      if (bondingCurve) {
        bondingCurveToMint.set(bondingCurve, tokenMint);
      }

      console.log("\n" + "🎉".repeat(40));
      console.log("🎓 GRADUATION TRANSACTION DETECTED!");
      console.log("─".repeat(80));
      console.log(`⏰ Time: ${new Date().toLocaleString()}`);
      console.log(`🪙 Token Mint: ${tokenMint}`);
      console.log(`📊 Bonding Curve: ${bondingCurve || 'N/A'}`);
      console.log(`📝 Transaction: https://solscan.io/tx/${signature}`);
      console.log(`🎯 Target AMM: ${targetAmm.toUpperCase()}`);
      console.log(`🔗 Pump.fun: https://pump.fun/coin/${tokenMint}`);
      console.log("🎉".repeat(40) + "\n");

      // Update database
      try {
        const token = await monitorService.getTokenByMint(tokenMint);
        if (token) {
          await monitorService.markTokenAsGraduated(token.id, signature);
          
          // Update pool status if we have the bonding curve
          if (bondingCurve) {
            const pool = await monitorService.getPoolByAddress(bondingCurve);
            if (pool) {
              await monitorService.updatePoolStatus(pool.id, 'graduated');
            }
          }
        }
      } catch (error) {
        console.error("Error updating database:", error);
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
        console.log("🏊 RAYDIUM POOL CREATED FOR GRADUATED TOKEN!");
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

        // Create new pool in database for the graduated token
        this.createGraduatedPool(baseMint, poolAddress, 'raydium', poolInfo);
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

  private async createGraduatedPool(tokenMint: string, poolAddress: string, platform: string, poolInfo: any) {
    try {
      const token = await monitorService.getTokenByMint(tokenMint);
      if (!token) {
        console.error(`Token not found for mint: ${tokenMint}`);
        return;
      }

      // Create a new pool entry for the graduated token
      await monitorService.savePool({
        pool_address: poolAddress,
        token_id: token.id,
        platform: platform === 'raydium' ? 'raydium' : 'pumpswap',
        pool_type: 'graduated',
        virtual_sol_reserves: poolInfo.lpReserve?.toString() || '0',
        virtual_token_reserves: poolInfo.pcReserve?.toString() || '0',
        real_sol_reserves: poolInfo.lpReserve?.toString() || '0',
        real_token_reserves: poolInfo.pcReserve?.toString() || '0',
        bonding_curve_progress: null, // No bonding curve for graduated tokens
        status: 'active',
        latest_price_sol: 0,
        latest_price_usd: 0,
      });

      console.log(`✅ Created graduated pool entry for ${tokenMint} on ${platform}`);
    } catch (error) {
      console.error("Error creating graduated pool:", error);
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
    
    if (accountStrings.includes(RAYDIUM_AMM_V4) || accountStrings.includes(RAYDIUM_CPMM)) {
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

  private async extractBondingCurveFromTx(txn: VersionedTransactionResponse, parsedIxs: any[]): Promise<string | null> {
    try {
      // Look for bonding curve in parsed instructions
      for (const ix of parsedIxs) {
        const bondingCurveAccount = ix.accounts?.find((acc: any) => 
          acc.name === "bondingCurve" || acc.name === "globalAccount"
        );
        if (bondingCurveAccount?.pubkey) {
          return bondingCurveAccount.pubkey.toString();
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
      RAYDIUM_CPMM,
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