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
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { SolanaParser } from "@shyft-to/solana-transaction-parser";
import { TransactionFormatter } from "./utils/transaction-formatter";
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import { SolanaEventParser } from "./utils/event-parser";
import { parseSwapTransactionOutput } from "./utils/pump-fun-parsed-transaction";
import pumpFunIdl from "./idls/pump_0.1.0.json";

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
  ping?: any;
}

interface BondingCurveState {
  tokenMint: string;
  solReserves: number;
  tokenReserves: number;
  progress: number;
  marketCap: number;
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
}

const TXN_FORMATTER = new TransactionFormatter();
const PUMP_FUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const PUMP_FUN_IX_PARSER = new SolanaParser([]);
PUMP_FUN_IX_PARSER.addParserFromIdl(
  PUMP_FUN_PROGRAM_ID.toBase58(),
  pumpFunIdl as Idl
);
const PUMP_FUN_EVENT_PARSER = new SolanaEventParser([], console);
PUMP_FUN_EVENT_PARSER.addParserFromIdl(
  PUMP_FUN_PROGRAM_ID.toBase58(),
  pumpFunIdl as Idl
);

// Constants for bonding curve calculation
const RESERVED_TOKENS = 206900000;
const INITIAL_REAL_TOKEN_RESERVES = 793100000;
const DECIMALS = 6;

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("Starting Pump.fun Bonding Curve Stream...");
  const stream = await client.subscribe();

  // Create `error` / `end` handler
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

  // Handle updates
  stream.on("data", (data) => {
    if (data?.transaction) {
      const txn = TXN_FORMATTER.formTransactionFromJson(
        data.transaction,
        Date.now()
      );

      const parsedTxn = decodePumpFun(txn);
      if (!parsedTxn) return;
      
      const swapData = parseSwapTransactionOutput(parsedTxn);
      if (!swapData) return;
      
      processBondingCurveUpdate(swapData, txn);
    }
  });

  // Send subscribe request
  await new Promise<void>((resolve, reject) => {
    stream.write(args, (err: any) => {
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

function processBondingCurveUpdate(swapData: any, txn: VersionedTransactionResponse) {
  try {
    // Extract data from parsed swap
    const tradeType = swapData.type;
    const solAmountLamports = tradeType === 'buy' ? swapData.in_amount : swapData.out_amount;
    const tokenAmountRaw = tradeType === 'buy' ? swapData.out_amount : swapData.in_amount;
    
    // Convert amounts
    const solAmount = solAmountLamports ? Number(solAmountLamports) / 1e9 : 0;
    const tokenAmount = tokenAmountRaw ? Number(tokenAmountRaw) / 1e6 : 0; // 6 decimals for pump.fun tokens
    
    // Calculate transaction impact on bonding curve
    const transactionImpact = calculateTransactionImpact(tokenAmount);
    
    const output = {
      timestamp: new Date().toISOString(),
      signature: txn.transaction.signatures[0],
      tradeType,
      tokenMint: swapData.mint,
      bondingCurve: swapData.bonding_curve,
      user: swapData.user,
      tokenAmount: tokenAmount.toFixed(6),
      solAmount: `${solAmount.toFixed(6)} SOL`,
      transactionImpact: `${transactionImpact.toFixed(4)}% of initial reserves`,
      note: "Monitor account state for actual bonding curve progress",
      solscanUrl: `https://solscan.io/tx/${txn.transaction.signatures[0]}`,
      pumpFunUrl: `https://pump.fun/coin/${swapData.mint}`
    };

    console.log(
      new Date(),
      ":",
      `Bonding Curve Update - ${tradeType.toUpperCase()}\n`,
      JSON.stringify(output, null, 2) + "\n"
    );
    console.log(
      "--------------------------------------------------------------------------------------------------"
    );
  } catch (err) {
    // Silent error handling
  }
}

function calculateTransactionImpact(tokenAmount: number): number {
  // Calculate how much this transaction moves the bonding curve
  // This is the percentage of initial token reserves being traded
  const impactPercentage = (Math.abs(tokenAmount) / INITIAL_REAL_TOKEN_RESERVES) * 100;
  return Math.min(impactPercentage, 100);
}

function generateProgressBar(progress: number): string {
  const filled = Math.floor(progress / 5);
  const empty = 20 - filled;
  return `[${"█".repeat(filled)}${"-".repeat(empty)}] ${progress.toFixed(1)}%`;
}

async function subscribeCommand(client: Client, args: SubscribeRequest) {
  console.log("Pump.fun Bonding Curve Progress Monitor");
  console.log("Monitoring bonding curve transactions...\n");
  console.log(`Bonding curve completes when all ${INITIAL_REAL_TOKEN_RESERVES.toLocaleString()} tokens are sold\n`);
  
  while (true) {
    try {
      await handleStream(client, args);
    } catch (error) {
      console.error("Stream error, restarting in 1 second...", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function decodePumpFun(tx: VersionedTransactionResponse) {
  if (tx.meta?.err) return;
  
  try {
    const parsedIxs = PUMP_FUN_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta!.loadedAddresses
    );
    
    const pumpFunIxs = parsedIxs.filter((ix) =>
      ix.programId.equals(PUMP_FUN_PROGRAM_ID) || 
      ix.programId.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))
    );
    
    const hydratedTx = hydrateLoadedAddresses(tx);
    const parsedInnerIxs = PUMP_FUN_IX_PARSER.parseTransactionWithInnerInstructions(hydratedTx);
    const pumpfunInnerIxs = parsedInnerIxs.filter((ix) =>
      ix.programId.equals(PUMP_FUN_PROGRAM_ID) || 
      ix.programId.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")) ||
      ix.programId.equals(new PublicKey("11111111111111111111111111111111"))
    );
    
    if (pumpFunIxs.length === 0 && pumpfunInnerIxs.length === 0) return;
    
    const events = PUMP_FUN_EVENT_PARSER.parseEvent(tx);
    const result = { instructions: pumpFunIxs, inner_ixs: pumpfunInnerIxs, events };
    bnLayoutFormatter(result);
    
    return result;
  } catch (err) {
    // Silent error handling
  }
}

function hydrateLoadedAddresses(tx: VersionedTransactionResponse): VersionedTransactionResponse {
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return tx;

  function ensurePublicKey(arr: (Buffer | PublicKey)[]) {
    return arr.map(item =>
      item instanceof PublicKey ? item : new PublicKey(item)
    );
  }

  tx.meta!.loadedAddresses = {
    writable: ensurePublicKey(loaded.writable),
    readonly: ensurePublicKey(loaded.readonly),
  };

  return tx;
}

const client = new Client(
  process.env.GRPC_URL!,
  process.env.X_TOKEN!,
  undefined
);

const req: SubscribeRequest = {
  accounts: {},
  slots: {},
  transactions: {
    PumpFun: {
      vote: false,
      failed: false,
      signature: undefined,
      accountInclude: [PUMP_FUN_PROGRAM_ID.toBase58()],
      accountExclude: [],
      accountRequired: [],
    },
  },
  transactionsStatus: {},
  entry: {},
  blocks: {},
  blocksMeta: {},
  accountsDataSlice: [],
  ping: undefined,
  commitment: CommitmentLevel.CONFIRMED,
};

subscribeCommand(client, req);