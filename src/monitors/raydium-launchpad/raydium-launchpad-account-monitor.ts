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
import { decodeRaydiumLaunchpadAccountData } from "./utils/raydium-launchpad-account-processor";

const RAYDIUM_LAUNCHPAD_PROGRAM_ID = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';

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

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("Starting Raydium Launchpad Account Monitor...")
  const stream = await client.subscribe();

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

  stream.on("data", async (data) => {
    try {
      const parsedLaunchpadAccount = await decodeRaydiumLaunchpadAccountData(data);
      if (!parsedLaunchpadAccount) return;
      
      displayAccountUpdate(parsedLaunchpadAccount);
    } catch (error) {
      if (error) {
        console.log(error);
      }
    }
  });
  
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

function displayAccountUpdate(accountData: any) {
  const { signature, pubKey, owner, parsedAccount } = accountData;
  
  console.log(`
Raydium Launchpad Account Update
========================================
Signature: ${signature || 'N/A'}
Account: ${pubKey}
Owner: ${owner}
Time: ${new Date().toISOString()}

Account Data:
${JSON.stringify(parsedAccount, null, 2)}
========================================
`);
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

const req: SubscribeRequest = {
  "slots": {},
  "accounts": {
    "raydium_launchpad": {
      "account": [],
      "filters": [],
      "owner": [RAYDIUM_LAUNCHPAD_PROGRAM_ID] 
    }
  },
  "transactions": {},
  "blocks": {},
  "blocksMeta": {},
  "accountsDataSlice": [],
  "commitment": CommitmentLevel.PROCESSED,
  entry: {},
  transactionsStatus: {}
}

// Start monitoring
console.log("Starting Raydium Launchpad Account Monitor");
console.log(`Connected to: ${process.env.GRPC_URL}`);
console.log(`Program ID: ${RAYDIUM_LAUNCHPAD_PROGRAM_ID}`);
console.log("Monitoring: Account updates\n");

subscribeCommand(client, req);