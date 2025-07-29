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
  // Camel case alternatives (just in case)
  virtualSolReserves?: any;
  virtualTokenReserves?: any;
  realSolReserves?: any;
  realTokenReserves?: any;
  tokenTotalSupply?: any;
  // Additional fields
  discriminator?: number[];
  bondingCurve?: string;
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

  constructor() {
    this.client = new Client(
      process.env.GRPC_URL!,
      process.env.X_TOKEN!,
      undefined
    );
    
    // Load the Pump.fun IDL
    const idl = JSON.parse(fs.readFileSync('./idls/pump_0.1.0.json', 'utf8'));
    this.accountCoder = new BorshAccountsCoder(idl);
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
    const tokenReservesDisplay = this.safeNumberConversion(realToken) / 1e9;
    const virtualSolDisplay = this.safeNumberConversion(virtualSol) / 1e9;
    const virtualTokenDisplay = this.safeNumberConversion(virtualToken) / 1e9;
    
    // Calculate price if reserves are available
    let price = 0;
    if (virtualToken && virtualSol) {
      const tokenAmount = this.safeNumberConversion(virtualToken);
      const solAmount = this.safeNumberConversion(virtualSol);
      if (tokenAmount > 0) {
        price = solAmount / tokenAmount;
      }
    }


    console.log("\n========== PUMP.FUN BONDING CURVE ==========");
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Account: ${accountInfo.pubkey}`);
    console.log(`Status: ${data.complete ? 'COMPLETED ✓' : 'ACTIVE'}`);
    
    if (data.creator) {
      console.log(`Creator: ${data.creator}`);
    }
    
    if (data.mint) {
      console.log(`Mint: ${data.mint}`);
    }
    
    console.log("\nReserves:");
    console.log(`  Real SOL: ${solReservesDisplay.toFixed(6)} SOL`);
    console.log(`  Real Tokens: ${tokenReservesDisplay.toFixed(2)}`);
    console.log(`  Virtual SOL: ${virtualSolDisplay.toFixed(6)} SOL`);
    console.log(`  Virtual Tokens: ${virtualTokenDisplay.toFixed(2)}`);
    
    if (tokenTotalSupply) {
      const totalSupplyDisplay = this.safeNumberConversion(tokenTotalSupply) / 1e9;
      console.log(`  Total Supply: ${totalSupplyDisplay.toFixed(2)}`);
    }
    
    if (price > 0) {
      console.log(`\nPrice: ${price.toFixed(9)} SOL per token`);
      console.log(`Market Cap: ${(price * (this.safeNumberConversion(tokenTotalSupply) / 1e9)).toFixed(4)} SOL`);
    }
    
    console.log(`\nAccount Balance: ${Number(accountInfo.lamports) / 1e9} SOL`);
    
    if (accountInfo.slot) {
      console.log(`Slot: ${accountInfo.slot}`);
    }
    
    console.log("===========================================\n");

    // Log detailed data for debugging
    if (process.env.DEBUG === 'true') {
      console.dir(accountInfo, { depth: null });
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
}

// Main execution
if (require.main === module) {
  const monitor = new PumpFunAccountMonitor();
  monitor.start().catch(console.error);
}