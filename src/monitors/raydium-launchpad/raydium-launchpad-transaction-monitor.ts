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
import { SubscribeRequestPing } from "@triton-one/yellowstone-grpc/dist/types/grpc/geyser";
import { TransactionFormatter } from "./utils/transaction-formatter";
import { SolanaEventParser } from "./utils/event-parser";
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import raydiumLaunchpadIdl from "./idls/raydium_launchpad.json";
import { monitorService } from "../../database";

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

// Transaction types we want to track
enum TransactionType {
  POOL_CREATION = "POOL_CREATION",
  BUY = "BUY",
  SELL = "SELL",
  ADD_LIQUIDITY = "ADD_LIQUIDITY",
  REMOVE_LIQUIDITY = "REMOVE_LIQUIDITY",
  UNKNOWN = "UNKNOWN"
}

interface ParsedTransaction {
  signature: string;
  slot: number;
  blockTime: number;
  type: TransactionType;
  user: string;
  data: any;
  instructions: any[];
  innerInstructions: any[];
  events: any[];
  success: boolean;
  fee: number;
}

const TXN_FORMATTER = new TransactionFormatter();
const RAYDIUM_LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"
);
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const RAYDIUM_LAUNCHPAD_IX_PARSER = new SolanaParser([]);
RAYDIUM_LAUNCHPAD_IX_PARSER.addParserFromIdl(
  RAYDIUM_LAUNCHPAD_PROGRAM_ID.toBase58(),
  raydiumLaunchpadIdl as Idl
);

const RAYDIUM_LAUNCHPAD_EVENT_PARSER = new SolanaEventParser([], console);
RAYDIUM_LAUNCHPAD_EVENT_PARSER.addParserFromIdl(
  RAYDIUM_LAUNCHPAD_PROGRAM_ID.toBase58(),
  raydiumLaunchpadIdl as Idl
);

// Transaction batching for better performance
const transactionBatch: any[] = [];
const BATCH_SIZE = 50;
const BATCH_TIMEOUT = 5000; // 5 seconds

let batchTimer: NodeJS.Timeout | null = null;

async function flushBatch() {
  if (transactionBatch.length === 0) return;
  
  const batch = [...transactionBatch];
  transactionBatch.length = 0;
  
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  
  try {
    await monitorService.saveTransactionBatch(batch);
    console.log(`💾 Batch of ${batch.length} transactions saved`);
  } catch (error) {
    console.error(`❌ Failed to save batch:`, error);
  }
}

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("🚀 Starting Comprehensive Raydium Launchpad Transaction Monitor...")
  const stream = await client.subscribe();

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

  // Handle updates
  stream.on("data", async (data) => {
    if (data?.transaction) {
      try {
        const txn = TXN_FORMATTER.formTransactionFromJson(
          data.transaction,
          Date.now()
        );

        const parsedTxn = await parseRaydiumLaunchpadTransaction(txn);
        if (parsedTxn) {
          await displayParsedTransaction(parsedTxn);
        }
      } catch (error) {
        console.error("Error processing transaction:", error);
      }
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

async function parseRaydiumLaunchpadTransaction(tx: VersionedTransactionResponse): Promise<ParsedTransaction | null> {
  if (tx.meta?.err) return null;

  try {
    // Parse instructions
    const parsedIxs = RAYDIUM_LAUNCHPAD_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta!.loadedAddresses
    );

    // Filter for Raydium Launchpad and Token Program instructions
    const raydiumLaunchpadIxs = parsedIxs.filter((ix) =>
      ix.programId.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID) ||
      ix.programId.equals(TOKEN_PROGRAM_ID)
    );

    // Parse inner instructions separately with error handling
    let raydiumLaunchpadInnerIxs: any[] = [];
    try {
      const parsedInnerIxs = RAYDIUM_LAUNCHPAD_IX_PARSER.parseTransactionWithInnerInstructions(tx);
      raydiumLaunchpadInnerIxs = parsedInnerIxs.filter((ix) =>
        ix.programId.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID) ||
        ix.programId.equals(TOKEN_PROGRAM_ID)
      );
    } catch (innerError) {
      // If inner instruction parsing fails, continue without them
      console.debug("Inner instruction parsing failed, continuing without them");
    }

    if (raydiumLaunchpadIxs.length === 0 && raydiumLaunchpadInnerIxs.length === 0) return null;

    // Parse events
    const events = RAYDIUM_LAUNCHPAD_EVENT_PARSER.parseEvent(tx);

    // Determine transaction type
    const transactionType = determineTransactionType(raydiumLaunchpadIxs);
    
    // Get the signer (user)
    const signer = getSigner(tx);

    // Extract specific data based on transaction type
    const transactionData = extractTransactionData(transactionType, raydiumLaunchpadIxs, raydiumLaunchpadInnerIxs, events);

    // Clean and format the data
    const cleanedInstructions = cleanInstructions(raydiumLaunchpadIxs);
    const cleanedInnerInstructions = cleanInstructions(raydiumLaunchpadInnerIxs);

    bnLayoutFormatter(cleanedInstructions);
    bnLayoutFormatter(cleanedInnerInstructions);
    bnLayoutFormatter(transactionData);
    bnLayoutFormatter(events);

    return {
      signature: tx.transaction.signatures[0],
      slot: tx.slot,
      blockTime: tx.blockTime || Date.now(),
      type: transactionType,
      user: signer,
      data: transactionData,
      instructions: cleanedInstructions,
      innerInstructions: cleanedInnerInstructions,
      events: events,
      success: !tx.meta?.err,
      fee: tx.meta?.fee || 0
    };
  } catch (err) {
    console.error("Error parsing transaction:", err);
    return null;
  }
}

function determineTransactionType(instructions: any[]): TransactionType {
  // Check instruction names to determine transaction type
  const instructionNames = instructions.map(ix => ix.name).filter(name => name !== "unknown");

  if (instructionNames.includes("initialize")) {
    return TransactionType.POOL_CREATION;
  } else if (instructionNames.some(name => name.includes("buy"))) {
    return TransactionType.BUY;
  } else if (instructionNames.some(name => name.includes("sell"))) {
    return TransactionType.SELL;
  } else if (instructionNames.includes("add_liquidity")) {
    return TransactionType.ADD_LIQUIDITY;
  } else if (instructionNames.includes("remove_liquidity")) {
    return TransactionType.REMOVE_LIQUIDITY;
  }

  return TransactionType.UNKNOWN;
}

function getSigner(tx: VersionedTransactionResponse): string {
  // The first signer is typically the transaction initiator
  const accountKeys = tx.version === "legacy" 
    ? (tx.transaction.message as any).accountKeys
    : (tx.transaction.message as any).staticAccountKeys;

  return accountKeys[0].toBase58();
}

function extractTransactionData(type: TransactionType, instructions: any[], innerInstructions: any[], events: any[]): any {
  const data: any = {};

  switch (type) {
    case TransactionType.POOL_CREATION:
      const initIx = instructions.find(ix => ix.name === "initialize");
      if (initIx) {
        data.poolId = initIx.accounts.find((acc: any) => acc.name === "pool_state")?.pubkey;
        data.baseMint = initIx.accounts.find((acc: any) => acc.name === "base_token_mint")?.pubkey;
        data.quoteMint = initIx.accounts.find((acc: any) => acc.name === "quote_token_mint")?.pubkey;
        data.baseVault = initIx.accounts.find((acc: any) => acc.name === "base_vault")?.pubkey;
        data.quoteVault = initIx.accounts.find((acc: any) => acc.name === "quote_vault")?.pubkey;
        data.lpMint = initIx.accounts.find((acc: any) => acc.name === "lp_mint")?.pubkey;
        
        // Look for mint initialization in inner instructions
        const mintInit = innerInstructions.find(ix => ix.name === "initializeMint2");
        if (mintInit) {
          data.decimals = mintInit.args?.decimals;
          data.mintAuthority = mintInit.args?.mintAuthority;
        }
      }
      break;

    case TransactionType.BUY:
    case TransactionType.SELL:
      const swapIx = instructions.find(ix => 
        ix.name.includes("buy") || ix.name.includes("sell")
      );
      if (swapIx) {
        // Following the Shyft example pattern - just pass through the raw values
        data.poolId = swapIx.accounts.find((acc: any) => acc.name === "pool_state")?.pubkey;
        data.payer = swapIx.accounts.find((acc: any) => acc.name === "payer")?.pubkey;
        data.baseMint = swapIx.accounts.find((acc: any) => acc.name === "base_token_mint")?.pubkey;
        data.quoteMint = swapIx.accounts.find((acc: any) => acc.name === "quote_token_mint")?.pubkey;
        
        // Get swap amounts from instruction args
        data.amountIn = swapIx.args?.amount_in?.toString() || swapIx.args?.amount_in;
        data.minimumAmountOut = swapIx.args?.minimum_amount_out?.toString() || swapIx.args?.minimum_amount_out;
        data.maximumAmountIn = swapIx.args?.maximum_amount_in?.toString() || swapIx.args?.maximum_amount_in;
        
        // Get actual amountOut from events if available
        if (events && events.length > 0) {
          // Look for TradeEvent which contains amount_out
          const tradeEvent = events.find((event: any) => 
            event.name === 'TradeEvent' || 
            event.data?.amount_out !== undefined ||
            event.data?.amountOut !== undefined
          );
          
          if (tradeEvent && tradeEvent.data) {
            // Use amount_out (snake_case) as that's what's in the IDL
            data.amountOut = tradeEvent.data.amount_out?.toString() || tradeEvent.data.amount_out;
            // Also extract other useful event data
            data.protocolFee = tradeEvent.data.protocol_fee?.toString() || tradeEvent.data.protocol_fee;
            data.platformFee = tradeEvent.data.platform_fee?.toString() || tradeEvent.data.platform_fee;
            data.shareFee = tradeEvent.data.share_fee?.toString() || tradeEvent.data.share_fee;
            data.tradeDirection = tradeEvent.data.trade_direction;
            
            // Add more event data for comprehensive output
            data.amountIn = tradeEvent.data.amount_in?.toString() || data.amountIn;
            data.totalBaseSell = tradeEvent.data.total_base_sell?.toString();
            data.virtualBase = tradeEvent.data.virtual_base?.toString();
            data.virtualQuote = tradeEvent.data.virtual_quote?.toString();
          }
        }
        
      }
      break;

    case TransactionType.ADD_LIQUIDITY:
    case TransactionType.REMOVE_LIQUIDITY:
      const liquidityIx = instructions.find(ix => 
        ix.name.includes("liquidity")
      );
      if (liquidityIx) {
        data.poolId = liquidityIx.accounts.find((acc: any) => acc.name === "pool_state")?.pubkey;
        data.lpAmount = liquidityIx.args?.lp_amount;
        data.baseAmount = liquidityIx.args?.base_amount;
        data.quoteAmount = liquidityIx.args?.quote_amount;
      }
      break;
  }

  return data;
}

function cleanInstructions(instructions: any[]): any[] {
  return instructions
    .filter((ix: any) => ix.name !== "unknown")
    .map((ix: any) => {
      // Remove any unknown fields
      if (ix.args?.unknown) {
        delete ix.args.unknown;
      }
      return ix;
    });
}

async function displayParsedTransaction(parsedTx: ParsedTransaction) {
  const typeEmoji = {
    [TransactionType.POOL_CREATION]: "🌟",
    [TransactionType.BUY]: "🟢",
    [TransactionType.SELL]: "🔴",
    [TransactionType.ADD_LIQUIDITY]: "💧",
    [TransactionType.REMOVE_LIQUIDITY]: "🔥",
    [TransactionType.UNKNOWN]: "❓"
  };

  // Helper to format transaction data for display
  const formatDataForDisplay = (data: any): any => {
    const formatted = { ...data };
    
    // Convert pubkeys to strings if they're objects
    Object.keys(formatted).forEach(key => {
      if (formatted[key]?.toBase58) {
        formatted[key] = formatted[key].toBase58();
      } else if (formatted[key]?.type === 'Buffer') {
        // Try to convert buffer to PublicKey
        try {
          const pubkey = new PublicKey(Buffer.from(formatted[key].data));
          formatted[key] = pubkey.toBase58();
        } catch {
          formatted[key] = 'Unknown';
        }
      }
    });
    
    return formatted;
  };

  const displayData = formatDataForDisplay(parsedTx.data);

  console.log(`
${typeEmoji[parsedTx.type]} ${parsedTx.type} Transaction Detected!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 Time: ${new Date(parsedTx.blockTime).toISOString()}
🔗 Signature: ${parsedTx.signature}
👤 User: ${parsedTx.user}
💰 Fee: ${parsedTx.fee / 1e9} SOL
✅ Success: ${parsedTx.success}
🔢 Slot: ${parsedTx.slot}

📊 Transaction Data:
${JSON.stringify(displayData, null, 2)}

📝 Instructions (${parsedTx.instructions.length}):
${parsedTx.instructions.map(ix => `  - ${ix.name}`).join('\n')}
${parsedTx.events.length > 0 ? `
📢 Events (${parsedTx.events.length}):
${parsedTx.events.map(evt => `  - ${evt.name || 'Event'}`).join('\n')}` : ''}

🔗 Explorer: https://solscan.io/tx/${parsedTx.signature}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  // Save pool creation to database
  if (parsedTx.type === TransactionType.POOL_CREATION && parsedTx.data.poolId && parsedTx.data.baseMint) {
    try {
      const poolData: PoolData = {
        pool_address: parsedTx.data.poolId,
        base_mint: parsedTx.data.baseMint,
        quote_mint: parsedTx.data.quoteMint || 'So11111111111111111111111111111111111111112', // Default to WSOL
        platform: 'raydium_launchpad',
        lp_mint: parsedTx.data.lpMint,
        base_vault: parsedTx.data.baseVault,
        quote_vault: parsedTx.data.quoteVault,
        // Initial liquidity will be populated from first transaction or account update
      };

      await poolOperations.insertPoolWithToken(poolData, parsedTx.data.baseMint);
      console.log(`💾 Pool saved to database: ${parsedTx.data.poolId}`);
    } catch (error: any) {
      if (error.message?.includes('Token not found')) {
        console.log(`⏳ Token ${parsedTx.data.baseMint} not yet in database. Pool creation will be retried when token is added.`);
      } else {
        console.error(`❌ Failed to save pool to database:`, error.message);
      }
    }
  }

  // Save buy/sell transactions to database
  if ((parsedTx.type === TransactionType.BUY || parsedTx.type === TransactionType.SELL) && 
      parsedTx.data.baseMint && parsedTx.data.poolId) {
    try {
      // Calculate SOL and token amounts
      const isBuy = parsedTx.type === TransactionType.BUY;
      let solAmount = 0;
      let tokenAmount = 0;
      
      // For Raydium, we need to determine which token is SOL
      const isBaseSol = parsedTx.data.baseMint === SOL_MINT.toBase58();
      const isQuoteSol = parsedTx.data.quoteMint === SOL_MINT.toBase58();
      
      if (isBuy) {
        // Buy: User sends SOL, receives tokens
        if (parsedTx.data.amountIn) {
          solAmount = parseInt(parsedTx.data.amountIn) / 1e9; // Convert lamports to SOL
        }
        if (parsedTx.data.amountOut) {
          // Assume token has 6 decimals unless we know otherwise
          tokenAmount = parseInt(parsedTx.data.amountOut) / 1e6;
        }
      } else {
        // Sell: User sends tokens, receives SOL
        if (parsedTx.data.amountIn) {
          tokenAmount = parseInt(parsedTx.data.amountIn) / 1e6;
        }
        if (parsedTx.data.amountOut) {
          solAmount = parseInt(parsedTx.data.amountOut) / 1e9;
        }
      }

      const monitorTx = {
        signature: parsedTx.signature,
        mint_address: parsedTx.data.baseMint,
        pool_address: parsedTx.data.poolId,
        block_time: new Date(parsedTx.blockTime),
        slot: parsedTx.slot,
        type: parsedTx.type === TransactionType.BUY ? 'buy' as const : 'sell' as const,
        user_address: parsedTx.user,
        sol_amount: solAmount.toString(),
        token_amount: tokenAmount.toString(),
        price_per_token: tokenAmount > 0 ? solAmount / tokenAmount : 0,
        metadata: {
          amountIn: parsedTx.data.amountIn,
          amountInDecimals: isBuy ? 9 : 6,
          amountOut: parsedTx.data.amountOut,
          amountOutDecimals: isBuy ? 6 : 9,
          protocolFee: parsedTx.data.protocolFee,
          platformFee: parsedTx.data.platformFee,
          transactionFee: parsedTx.fee,
          success: parsedTx.success,
          rawData: {
            program: 'raydium_launchpad',
            transactionData: parsedTx.data,
            events: parsedTx.events,
            instructions: parsedTx.instructions.map((ix: any) => ix.name)
          }
        }
      };

      // Add to batch
      transactionBatch.push(monitorTx);
      console.log(`📦 ${parsedTx.type} transaction added to batch (${transactionBatch.length}/${BATCH_SIZE})`);
      
      // Flush if batch is full
      if (transactionBatch.length >= BATCH_SIZE) {
        await flushBatch();
      } else {
        // Set timer for batch timeout
        if (!batchTimer) {
          batchTimer = setTimeout(flushBatch, BATCH_TIMEOUT);
        }
      }
    } catch (error) {
      console.error(`❌ Failed to save transaction to database:`, error);
    }
  }
}

async function subscribeCommand(client: Client, args: SubscribeRequest) {
  while (true) {
    try {
      await handleStream(client, args);
    } catch (error) {
      console.error("Stream error, restarting in 1 second...", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
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
    Raydium_Launchpad: {
      vote: false,
      failed: false,
      signature: undefined,
      accountInclude: [RAYDIUM_LAUNCHPAD_PROGRAM_ID.toBase58()],
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

// Start monitoring
console.log("🔍 Starting Raydium Launchpad Transaction Monitor");
console.log(`📡 Connected to: ${process.env.GRPC_URL}`);
console.log(`🎯 Program ID: ${RAYDIUM_LAUNCHPAD_PROGRAM_ID.toBase58()}`);
console.log("📊 Monitoring: ALL transaction types\n");

subscribeCommand(client, req);