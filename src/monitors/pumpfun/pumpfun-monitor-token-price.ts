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
import { getDbPool } from "../../database";
// import { pumpfunIntegration } from "../utils/enhanced-integration"; // Removed during cleanup

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
      const formattedSwapTxn = parseSwapTransactionOutput(parsedTxn);
      
      if (!formattedSwapTxn) return;
      
      // Get current SOL price for USD calculations
      let priceUsd = null;
      let marketCapUsd = null;
      try {
        const solPriceResult = await dbPool.query(
          'SELECT price_usd FROM sol_usd_prices ORDER BY price_time DESC LIMIT 1'
        );
        if (solPriceResult.rows.length > 0) {
          const solPrice = parseFloat(solPriceResult.rows[0].price_usd);
          priceUsd = parseFloat(formattedSwapTxn.formattedPrice) * solPrice;
          marketCapUsd = priceUsd * 1_000_000_000; // 1 billion token supply
        }
      } catch (error) {
        console.error('Error fetching SOL price:', error);
      }
      
      console.log(
        new Date(),
        ":",
        `New transaction https://translator.shyft.to/tx/${txn.transaction.signatures[0]}`,
        `\n📊 Bonding Curve Progress: ${formattedSwapTxn.bondingCurveProgress.toFixed(2)}%`,
        `\n💰 Price: ${formattedSwapTxn.formattedPrice} SOL` + (priceUsd ? ` ($${priceUsd.toFixed(9)} USD)` : ''),
        `\n📈 Market Cap:` + (marketCapUsd ? ` $${marketCapUsd.toFixed(2)} USD` : ' N/A'),
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
        `;
        
        await dbPool.query(updateQuery, [
          formattedSwapTxn.virtual_sol_reserves.toString(),
          formattedSwapTxn.virtual_token_reserves.toString(),
          formattedSwapTxn.real_sol_reserves?.toString() || '0',
          formattedSwapTxn.real_token_reserves?.toString() || '0',
          formattedSwapTxn.formattedPrice,
          priceUsd ? priceUsd.toFixed(20).replace(/0+$/, '') : null,
          formattedSwapTxn.bondingCurveProgress.toFixed(2),
          formattedSwapTxn.bonding_curve
        ]);
        
        console.log("💾 Price update saved to database");
        
        // Update technical score based on price change
        // Technical scores are calculated on-demand in dashboard
        // await pumpfunIntegration.onPriceUpdate(formattedSwapTxn);
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