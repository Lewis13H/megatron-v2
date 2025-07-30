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
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import { SolanaEventParser } from "./utils/event-parser";
import { parseSwapTransactionOutput } from "./utils/pump-fun-parsed-transaction";
import pumpFunIdl from "./idls/pump_0.1.0.json";
import { savePumpfunToken } from "../../database/monitor-integration";

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

interface SwapEvent {
  type: 'buy' | 'sell';
  user: string;
  mint: string;
  bondingCurve: string;
  solAmount: number;
  tokenAmount: number;
  timestamp: string;
  signature: string;
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

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("Starting Pump.fun Transaction Monitor...")
  console.log("Monitoring for buy/sell events...\n");
  
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

      const parsedTxn = decodePumpFunTransaction(txn);
      if (!parsedTxn) return;
      
      const swapData = parseSwapTransactionOutput(parsedTxn);
      if (!swapData) return;
      
      // Format the output
      const solAmountLamports = swapData.type === 'buy' ? swapData.in_amount : swapData.out_amount;
      const tokenAmountRaw = swapData.type === 'buy' ? swapData.out_amount : swapData.in_amount;
      
      // Handle potential undefined/null values
      const solAmount = solAmountLamports ? Number(solAmountLamports) / 1e9 : 0;
      const tokenAmount = tokenAmountRaw ? Number(tokenAmountRaw) / 1e6 : 0; // Assuming 6 decimals for pump.fun tokens
      
      const output: SwapEvent = {
        timestamp: new Date().toISOString(),
        signature: txn.transaction.signatures[0],
        type: swapData.type,
        user: swapData.user,
        mint: swapData.mint,
        bondingCurve: swapData.bonding_curve,
        solAmount: solAmount,
        tokenAmount: tokenAmount,
      };
      
      console.log(
        `[${output.type.toUpperCase()}]`,
        new Date(),
        "\n",
        JSON.stringify({
          ...output,
          solAmount: `${output.solAmount.toFixed(6)} SOL`,
          tokenAmount: output.tokenAmount.toLocaleString(undefined, { 
            minimumFractionDigits: 3,
            maximumFractionDigits: 3 
          }),
          pumpFunUrl: `https://pump.fun/coin/${output.mint}`,
          solscanUrl: `https://solscan.io/tx/${output.signature}`,
          shyftUrl: `https://translator.shyft.to/tx/${output.signature}`
        }, null, 2) + "\n"
      );
      
      // Note: This monitor tracks all transactions, not just creation
      // For new token detection, use pumpfun-monitor-new-token-mint.ts
      // We could save first transaction per token, but that would require
      // checking if token already exists in DB
      
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
  console.log("Pump.fun Transaction Monitor");
  console.log("==========================");
  console.log("Program ID:", PUMP_FUN_PROGRAM_ID.toBase58());
  console.log("");
  
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

function decodePumpFunTransaction(tx: VersionedTransactionResponse) {
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
    // Silent error handling for unrecognized instructions
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