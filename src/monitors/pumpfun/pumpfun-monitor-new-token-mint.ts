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
import { Connection, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { tOutPut } from "./utils/transactionOutput";
import { publicKey } from "@solana/buffer-layout-utils";
import { savePumpfunToken } from "../../database/monitor-integration";
import { getDbPool, PoolOperations, PoolData } from "../../database";

const pumpfun = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

// Initialize database operations
const dbPool = getDbPool();
const poolOperations = new PoolOperations(dbPool);

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

  async function handleStream(client: Client, args: SubscribeRequest) {
  // Subscribe for events
  const stream = await client.subscribe();
  console.log("Starting Stream....")

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
    try{

     const result = await tOutPut(data);

     const Ca = result.meta.postTokenBalances[0].mint;
     const signature = result.signature; // signature is at top level
   
    console.log(`
      NEWLY MINTED
      Ca : ${Ca}
      Signature: ${signature}
      Timestamp: ${new Date().toISOString()}
    
   `);
   
   // Save to database
   const tokenData = {
     Ca: Ca,
     mint: Ca,
     signature: signature,
     timestamp: new Date().toISOString(),
     creator: result.message.accountKeys[0] // First signer is usually creator
   };
   
   savePumpfunToken(tokenData).catch(error => {
     console.error("Failed to save Pump.fun token to database:", error);
   });
   
 
}catch(error){
  if(error){
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
  undefined,
);

const req = {
accounts: {},
slots: {},
transactions: {
  pumpfun: {
    vote: false,
    failed: false,
    signature: undefined,
    accountInclude: [pumpfun], //Address 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
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
commitment: CommitmentLevel.PROCESSED, //for receiving confirmed txn updates
};

subscribeCommand(client,req);