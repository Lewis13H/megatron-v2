import "dotenv/config";
import Client, {
  CommitmentLevel,
  SubscribeRequestAccountsDataSlice,
  SubscribeRequestFilterAccounts,
  SubscribeRequestFilterBlocks,
  SubscribeRequestFilterBlocksMeta,
  SubscribeRequestFilterEntry,
  SubscribeRequestFilterSlots,
  SubscribeRequestFilterTransactions,
} from "@triton-one/yellowstone-grpc";
import { SubscribeRequestPing } from "@triton-one/yellowstone-grpc/dist/types/grpc/geyser";
import * as fs from 'fs';
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import bs58 from 'bs58';

// Import utility function
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import { getDbPool, PoolOperations, PoolData } from "../../database";

const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

interface SubscribeRequest {
  accounts: { [key: string]: SubscribeRequestFilterAccounts };
  slots: { [key: string]: SubscribeRequestFilterSlots };
  transactions: { [key: string]: SubscribeRequestFilterTransactions };
  transactionsStatus: { [key: string]: SubscribeRequestFilterTransactions };
  blocks: { [key: string]: SubscribeRequestFilterBlocks };
  blocksMeta: { [key: string]: SubscribeRequestFilterBlocksMeta };
  entry: { [key: string]: SubscribeRequestFilterEntry };
  commitment?: CommitmentLevel | undefined;
  accountsDataSlice: SubscribeRequestAccountsDataSlice[];
  ping?: SubscribeRequestPing | undefined;
}

interface BondingCurveAccount {
  // Snake case fields (actual field names from Pump.fun)
  virtual_sol_reserves?: any;
  virtual_token_reserves?: any;
  real_sol_reserves?: any;
  real_token_reserves?: any;
  token_total_supply?: any;
  complete?: boolean;
  creator?: string;
  mint?: string;
  token_mint?: string;
  // Camel case alternatives (just in case)
  virtualSolReserves?: any;
  virtualTokenReserves?: any;
  realSolReserves?: any;
  realTokenReserves?: any;
  tokenTotalSupply?: any;
  tokenMint?: string;
  // Additional fields
  discriminator?: number[];
  bondingCurve?: string;
  // Allow any other fields
  [key: string]: any;
}

interface AccountInfo {
  pubkey: string;
  data: BondingCurveAccount;
  owner: string;
  lamports: bigint;
  executable: boolean;
  rentEpoch: bigint;
  slot?: bigint;
}

export class PumpFunAccountMonitor {
  private client: Client;
  private accountCoder: BorshAccountsCoder;
  private poolOperations: PoolOperations;

  constructor() {
    this.client = new Client(
      process.env.GRPC_URL!,
      process.env.X_TOKEN!,
      undefined
    );
    
    // Load the Pump.fun IDL
    const idl = JSON.parse(fs.readFileSync(__dirname + '/idls/pump_0.1.0.json', 'utf8'));
    this.accountCoder = new BorshAccountsCoder(idl);
    
    // Initialize database operations
    const dbPool = getDbPool();
    this.poolOperations = new PoolOperations(dbPool);
  }

  async start() {
    console.log("Starting Pump.fun Account Monitor...");
    console.log(`Monitoring accounts owned by: ${PUMP_FUN_PROGRAM_ID}`);
    
    while (true) {
      try {
        await this.handleStream();
      } catch (error) {
        console.error("Stream error, restarting in 1 second...", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleStream() {
    const stream = await this.client.subscribe();

    // Create error/end handler
    const streamClosed = new Promise<void>((resolve, reject) => {
      stream.on("error", (error) => {
        console.log("ERROR", error);
        reject(error);
        stream.end();
      });
      stream.on("end", () => {
        resolve();
      });
      stream.on("close", () => {
        resolve();
      });
    });

    // Handle account updates
    stream.on("data", async (data) => {
      try {
        if (data?.account) {
          const accountInfo = this.processAccountData(data.account);
          if (accountInfo) {
            this.outputAccountUpdate(accountInfo);
          }
        }
      } catch (error) {
        console.error("Error processing account data:", error);
      }
    });

    // Subscribe to Pump.fun owned accounts
    const request: SubscribeRequest = {
      slots: {},
      accounts: {
        pumpfun: {
          account: [],
          filters: [],
          owner: [PUMP_FUN_PROGRAM_ID]
        }
      },
      transactions: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED, // Fastest updates
      entry: {},
      transactionsStatus: {}
    };

    // Send subscribe request
    await new Promise<void>((resolve, reject) => {
      stream.write(request, (err: any) => {
        if (err === null || err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      });
    }).catch((reason) => {
      console.error(reason);
      throw reason;
    });

    await streamClosed;
  }

  private processAccountData(accountData: any): AccountInfo | null {
    try {
      // Decode the account data
      const decodedData = this.accountCoder.decodeAny(accountData.account.data);
      
      if (!decodedData) {
        return null;
      }

      // Apply BigNumber formatting
      bnLayoutFormatter(decodedData);

      // Construct account info
      const accountInfo: AccountInfo = {
        pubkey: bs58.encode(accountData.account.pubkey),
        data: decodedData as BondingCurveAccount,
        owner: bs58.encode(accountData.account.owner),
        lamports: accountData.account.lamports,
        executable: accountData.account.executable,
        rentEpoch: accountData.account.rentEpoch,
        slot: accountData.slot
      };

      return accountInfo;
    } catch (error) {
      // Silently skip accounts that can't be decoded (likely not bonding curve accounts)
      return null;
    }
  }

  private outputAccountUpdate(accountInfo: AccountInfo) {
    const data = accountInfo.data;
    
    // Debug: Log raw data structure
    if (process.env.DEBUG === 'true') {
      console.log("Raw account data:", JSON.stringify(data, null, 2));
    }
    
    // Calculate derived metrics - handle both string and number formats
    // Check for snake_case field names first, then camelCase
    const realSol = data.real_sol_reserves || data.realSolReserves;
    const realToken = data.real_token_reserves || data.realTokenReserves;
    const virtualSol = data.virtual_sol_reserves || data.virtualSolReserves;
    const virtualToken = data.virtual_token_reserves || data.virtualTokenReserves;
    const tokenTotalSupply = data.token_total_supply || data.tokenTotalSupply;
    
    const solReservesDisplay = this.safeNumberConversion(realSol) / 1e9;
    const tokenReservesDisplay = this.safeNumberConversion(realToken) / 1e6;  // Pump.fun tokens have 6 decimals
    const virtualSolDisplay = this.safeNumberConversion(virtualSol) / 1e9;
    const virtualTokenDisplay = this.safeNumberConversion(virtualToken) / 1e6;  // Pump.fun tokens have 6 decimals
    
    // Calculate price if reserves are available
    let price = 0;
    if (virtualToken && virtualSol) {
      // Convert to actual amounts
      const solAmount = this.safeNumberConversion(virtualSol) / 1e9; // lamports to SOL
      const tokenAmount = this.safeNumberConversion(virtualToken) / 1e6; // tokens with 6 decimals
      if (tokenAmount > 0) {
        price = solAmount / tokenAmount;
      }
    }
    
    // Calculate bonding curve progress using token reserves
    // This is the correct method based on Pump.fun's bonding curve mechanics
    const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000 * 1e6;  // 1.073 billion tokens
    const TOTAL_SELLABLE_TOKENS = 793_100_000 * 1e6;  // 793.1 million tokens can be sold
    let bondingCurveProgress = 0;
    
    if (virtualToken) {
      const virtualTokenReserves = this.safeNumberConversion(virtualToken);
      const tokensSold = INITIAL_VIRTUAL_TOKEN_RESERVES - virtualTokenReserves;
      bondingCurveProgress = (tokensSold / TOTAL_SELLABLE_TOKENS) * 100;
      bondingCurveProgress = Math.max(0, Math.min(100, bondingCurveProgress)); // Clamp between 0-100
    }
    
    // Also calculate SOL in account for reference (this correlates with progress)
    const accountSolBalance = Number(accountInfo.lamports) / 1e9;  // Convert lamports to SOL
    const TARGET_SOL_FOR_GRADUATION = 84;  // Approximate SOL when bonding curve completes


    console.log("\n========== PUMP.FUN BONDING CURVE ==========");
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Account: ${accountInfo.pubkey}`);
    console.log(`Status: ${data.complete ? 'COMPLETED ✓' : 'ACTIVE'}`);
    
    if (data.creator) {
      console.log(`Creator: ${data.creator}`);
    }
    
    // Debug: Check all possible mint field names
    const mintAddress = data.mint || data.token_mint || data.tokenMint;
    if (mintAddress) {
      console.log(`Mint: ${mintAddress}`);
      console.log(`Pump.fun URL: https://pump.fun/coin/${mintAddress}`);
    } else {
      // Pump.fun bonding curves don't store mint in account data
      // The mint needs to be derived or obtained from monitoring transactions
      console.log(`Mint: [Derive from transactions or use bonding curve PDA]`);
      console.log(`Note: Monitor transactions to capture mint addresses`);
    }
    
    console.log("\nReserves:");
    console.log(`  Real SOL: ${solReservesDisplay.toFixed(6)} SOL`);
    console.log(`  Real Tokens: ${tokenReservesDisplay.toFixed(2)}`);
    console.log(`  Virtual SOL: ${virtualSolDisplay.toFixed(6)} SOL`);
    console.log(`  Virtual Tokens: ${virtualTokenDisplay.toFixed(2)}`);
    
    if (tokenTotalSupply) {
      const totalSupplyDisplay = this.safeNumberConversion(tokenTotalSupply) / 1e6;  // Pump.fun tokens have 6 decimals
      console.log(`  Total Supply: ${totalSupplyDisplay.toFixed(2)}`);
    }
    
    console.log("\nBonding Curve Progress:");
    console.log(`  Progress: ${bondingCurveProgress.toFixed(2)}%`);
    console.log(`  Progress Bar: ${this.generateProgressBar(bondingCurveProgress)}`);
    
    // Show different message based on progress
    if (bondingCurveProgress >= 100 || data.complete) {
      console.log(`  Status: READY FOR GRADUATION 🎓`);
      if (!data.complete) {
        console.log(`  Note: Awaiting migration to Raydium`);
      }
    } else {
      // Calculate approximate remaining SOL based on progress
      const expectedSolAtProgress = (bondingCurveProgress / 100) * TARGET_SOL_FOR_GRADUATION;
      const remainingSol = TARGET_SOL_FOR_GRADUATION - expectedSolAtProgress;
      console.log(`  SOL Remaining: ~${remainingSol.toFixed(2)} SOL needed to graduate`);
      console.log(`  Progress to graduation: ${bondingCurveProgress.toFixed(2)}%`);
      console.log(`  Current SOL in curve: ${accountSolBalance.toFixed(2)} SOL`);
    }
    
    if (price > 0) {
      // Pump.fun tokens have 1 billion total supply
      const TOTAL_SUPPLY = 1_000_000_000;
      const marketCapSol = price * TOTAL_SUPPLY;
      console.log(`\nPrice: ${price.toFixed(20).replace(/0+$/, '')} SOL per token`);
      console.log(`Market Cap: ${marketCapSol.toFixed(4)} SOL`);
    }
    
    console.log(`\nAccount Balance: ${accountSolBalance.toFixed(6)} SOL`);
    
    if (accountInfo.slot) {
      console.log(`Slot: ${accountInfo.slot}`);
    }
    
    console.log("===========================================\n");

    // Log detailed data for debugging
    if (process.env.DEBUG === 'true') {
      console.dir(accountInfo, { depth: null });
    }
    
    // Update pool in database using bonding curve address
    // Note: Pump.fun bonding curve accounts don't contain mint address
    this.updatePoolInDatabase(accountInfo.pubkey, {
      virtualSol: virtualSol,
      virtualToken: virtualToken,
      realSol: realSol,
      realToken: realToken,
      progress: bondingCurveProgress,
      complete: data.complete || false,
      price: price > 0 ? price.toFixed(20).replace(/0+$/, '') : undefined
    });
  }
  
  private async updatePoolInDatabase(bondingCurveAddress: string, data: {
    virtualSol: any;
    virtualToken: any;  
    realSol: any;
    realToken: any;
    progress: number;
    complete: boolean;
    price?: string;
  }) {
    try {
      const updateData: any = {
        virtual_sol_reserves: data.virtualSol?.toString(),
        virtual_token_reserves: data.virtualToken?.toString(),
        real_sol_reserves: data.realSol?.toString(),
        real_token_reserves: data.realToken?.toString(),
        bonding_curve_progress: data.progress
      };
      
      // Add price if available
      if (data.price) {
        updateData.latest_price = data.price;
      }
      
      await this.poolOperations.updatePoolReserves(bondingCurveAddress, updateData);
      
      // Update status if completed
      if (data.complete) {
        await this.poolOperations.updatePoolStatus(bondingCurveAddress, 'graduated');
      }
      
      console.log(`💾 Pool reserves updated in database for ${bondingCurveAddress}`);
    } catch (error) {
      console.error(`❌ Failed to update pool in database:`, error);
    }
  }

  private safeNumberConversion(value: any): number {
    if (value === null || value === undefined) {
      return 0;
    }
    
    // Handle string representation of numbers
    if (typeof value === 'string') {
      return parseFloat(value) || 0;
    }
    
    // Handle BigNumber objects
    if (value.toString && typeof value.toString === 'function') {
      return parseFloat(value.toString()) || 0;
    }
    
    // Handle regular numbers
    if (typeof value === 'number') {
      return value;
    }
    
    return 0;
  }
  
  private generateProgressBar(progress: number): string {
    const filled = Math.floor(progress / 5);
    const empty = 20 - filled;
    return `[${"█".repeat(filled)}${"-".repeat(empty)}] ${progress.toFixed(1)}%`;
  }
}

// Main execution
if (require.main === module) {
  const monitor = new PumpFunAccountMonitor();
  monitor.start().catch(console.error);
}