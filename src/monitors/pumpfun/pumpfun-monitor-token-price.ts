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
import pumpFunAmmIdl from "./idls/pump_0.1.0.json";
import { parseSwapTransactionOutput } from "./utils/pumpfun_formatted_txn";
import { getDbPool, monitorService } from "../../database";
import { scoreIntegration } from "./utils/score-integration";

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

const TXN_FORMATTER = new TransactionFormatter();
const PUMP_FUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const PUMP_FUN_IX_PARSER = new SolanaParser([]);
PUMP_FUN_IX_PARSER.addParserFromIdl(
  PUMP_FUN_PROGRAM_ID.toBase58(),
  pumpFunAmmIdl as Idl
);
const PUMP_FUN_EVENT_PARSER = new SolanaEventParser([], console);
PUMP_FUN_EVENT_PARSER.addParserFromIdl(
  PUMP_FUN_PROGRAM_ID.toBase58(),
  pumpFunAmmIdl as Idl
);

// Initialize database pool
const dbPool = getDbPool();

// Cache SOL price for 5 seconds to reduce DB queries
let solPriceCache: { price: number; timestamp: number } | null = null;
const SOL_PRICE_CACHE_MS = 5000;

async function getCachedSolPrice(): Promise<number> {
  const now = Date.now();
  if (solPriceCache && (now - solPriceCache.timestamp) < SOL_PRICE_CACHE_MS) {
    return solPriceCache.price;
  }
  
  try {
    const result = await dbPool.query(
      'SELECT price_usd FROM sol_usd_prices ORDER BY price_time DESC LIMIT 1'
    );
    const price = result.rows[0]?.price_usd ? parseFloat(result.rows[0].price_usd) : 165;
    solPriceCache = { price, timestamp: now };
    return price;
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    return solPriceCache?.price || 165;
  }
}

async function handleStream(client: Client, args: SubscribeRequest) {
  // Subscribe for events
  console.log("Streaming ...");
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
  stream.on("data", async (data) => {
    if (data?.transaction) {
      const txn = TXN_FORMATTER.formTransactionFromJson(
        data.transaction,
        Date.now()
      );

      const parsedTxn = decodePumpFunTxn(txn);

      if (!parsedTxn) return;
      
      // Check if this is a buy or sell transaction
      const swapInstruction = parsedTxn.instructions?.pumpFunIxs?.find(
        (ix: any) => ix.name === 'buy' || ix.name === 'sell'
      );
      
      if (!swapInstruction) return; // Skip non-swap transactions
      
      const formattedSwapTxn = parseSwapTransactionOutput(parsedTxn);
      
      if (!formattedSwapTxn) return;
      
      // Get current SOL price for USD calculations (using cache)
      const solPrice = await getCachedSolPrice();
      const priceUsd = parseFloat(formattedSwapTxn.formattedPrice) * solPrice;
      const marketCapUsd = priceUsd * 1_000_000_000; // 1 billion token supply
      
      console.log(
        new Date(),
        ":",
        `New ${swapInstruction.name} transaction https://translator.shyft.to/tx/${txn.transaction.signatures[0]}`,
        `\n📊 Bonding Curve Progress: ${formattedSwapTxn.bondingCurveProgress.toFixed(2)}%`,
        `\n💰 Price: ${formattedSwapTxn.formattedPrice} SOL ($${priceUsd.toFixed(9)} USD)`,
        `\n📈 Market Cap: $${marketCapUsd.toFixed(2)} USD`,
        `\n${JSON.stringify(formattedSwapTxn, null, 2)}\n`
      );
      
      // Save to database
      try {
        // Update pool reserves in database
        // For Pump.fun, the bonding curve address IS the pool address
        const updateQuery = `
          UPDATE pools 
          SET 
            virtual_sol_reserves = $1,
            virtual_token_reserves = $2,
            real_sol_reserves = $3,
            real_token_reserves = $4,
            latest_price = $5,
            latest_price_usd = $6,
            bonding_curve_progress = $7,
            bonding_curve_address = $8,
            updated_at = NOW()
          WHERE pool_address = $8
          RETURNING token_id, id
        `;
        
        const poolResult = await dbPool.query(updateQuery, [
          formattedSwapTxn.virtual_sol_reserves.toString(),
          formattedSwapTxn.virtual_token_reserves.toString(),
          formattedSwapTxn.real_sol_reserves?.toString() || '0',
          formattedSwapTxn.real_token_reserves?.toString() || '0',
          formattedSwapTxn.formattedPrice,
          priceUsd.toFixed(20).replace(/0+$/, ''),
          formattedSwapTxn.bondingCurveProgress.toFixed(2),
          formattedSwapTxn.bonding_curve
        ]);
        
        // Save transaction record if pool exists
        if (poolResult.rows.length > 0) {
          const { token_id, id: pool_id } = poolResult.rows[0];
          
          // Calculate SOL amount from the swap
          // For buys: user sends SOL, for sells: user receives SOL
          const solAmount = Math.abs(
            (parseFloat(formattedSwapTxn.virtual_sol_reserves) - parseFloat(formattedSwapTxn.real_sol_reserves)) / 1e9
          );
          
          const userAccount = swapInstruction.accounts?.find((a: any) => a.name === 'user');
          const userAddress = userAccount?.pubkey ? 
            (typeof userAccount.pubkey === 'string' ? userAccount.pubkey : userAccount.pubkey.toString()) : '';
          
          await monitorService.saveTransaction({
            signature: txn.transaction.signatures[0],
            token_id,
            pool_id,
            type: swapInstruction.name as 'buy' | 'sell',
            block_time: new Date(),
            slot: data.slot || 0,
            user_address: userAddress,
            sol_amount: solAmount.toString(),
            token_amount: '0', // Would need to calculate from reserves change
            price_per_token: parseFloat(formattedSwapTxn.formattedPrice),
            metadata: {
              bondingCurveProgress: formattedSwapTxn.bondingCurveProgress,
              virtualSolReserves: formattedSwapTxn.virtual_sol_reserves,
              virtualTokenReserves: formattedSwapTxn.virtual_token_reserves,
              priceUsd: priceUsd,
              marketCapUsd: marketCapUsd
            }
          });
        }
        
        console.log("💾 Price update and transaction saved to database");
        
        // Calculate technical score after price update
        await scoreIntegration.onPriceUpdate(
          formattedSwapTxn.mint,
          parseFloat(formattedSwapTxn.formattedPrice),
          formattedSwapTxn.bondingCurveProgress
        );
      } catch (error) {
        console.error("❌ Failed to save price update:", error);
      }
      
      console.log(
        "--------------------------------------------------------------------------------------------------"
      );
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
  process.env.X_TOKEN,
  undefined
);

const req: SubscribeRequest = {
  accounts: {},
  slots: {},
  transactions: {
    pumpFun: {
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

function decodePumpFunTxn(tx: VersionedTransactionResponse) {
  if (tx.meta?.err) return;
  try{
  const paredIxs = PUMP_FUN_IX_PARSER.parseTransactionData(
    tx.transaction.message,
    tx.meta!.loadedAddresses,
  );

  const pumpFunIxs = paredIxs.filter((ix) =>
    ix.programId.equals(PUMP_FUN_PROGRAM_ID) || ix.programId.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")),
  );

  const parsedInnerIxs = PUMP_FUN_IX_PARSER.parseTransactionWithInnerInstructions(tx);

  const pumpfun_amm_inner_ixs = parsedInnerIxs.filter((ix) =>
    ix.programId.equals(PUMP_FUN_PROGRAM_ID) || ix.programId.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")),
  );


  if (pumpFunIxs.length === 0) return;
  const events = PUMP_FUN_EVENT_PARSER.parseEvent(tx);
  const result = { instructions: {pumpFunIxs,events}, inner_ixs:  pumpfun_amm_inner_ixs };
  bnLayoutFormatter(result);
  return result;
  }catch(err){
  }
}