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
import pumpFunIdl from "./idls/pump_0.1.0.json";
import { savePumpfunToken } from "../../database/monitor-integration";
import { getDbPool, PoolOperations } from "../../database";

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

interface TokenMetadata {
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  showName?: boolean;
  [key: string]: any;
}

interface CreateTokenData {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  mintAuthority: string;
  bondingCurve: string;
  associatedBondingCurve: string;
  global: string;
  mplTokenMetadata: string;
  metadata: string;
  user: string;
  timestamp: string;
  signature: string;
  slot?: number;
  offChainMetadata?: TokenMetadata;
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

// Initialize database operations
const dbPool = getDbPool();
const poolOperations = new PoolOperations(dbPool);

// Function to fetch metadata from URI
async function fetchTokenMetadata(uri: string): Promise<TokenMetadata | null> {
  try {
    // Handle IPFS URIs
    let fetchUrl = uri;
    if (uri.startsWith('ipfs://')) {
      // Use a public IPFS gateway
      fetchUrl = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    } else if (uri.includes('/ipfs/')) {
      // Already formatted as gateway URL, try alternative gateways if needed
      fetchUrl = uri.replace('https://ipfs.io/', 'https://gateway.pinata.cloud/');
    }
    
    console.log(`📡 Fetching metadata from: ${fetchUrl}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(fetchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.error(`❌ Failed to fetch metadata: ${response.status} ${response.statusText}`);
      return null;
    }
    
    const metadata = await response.json() as TokenMetadata;
    console.log(`✅ Successfully fetched metadata`);
    return metadata;
  } catch (error) {
    console.error(`❌ Error fetching metadata:`, error);
    return null;
  }
}

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("Starting Pump.fun New Token Mint Monitor V2...")
  console.log("Monitoring for new token creation events with metadata extraction...\n");
  
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

      const parsedTxn = decodePumpFunTransaction(txn);
      if (!parsedTxn) return;
      
      // Look for create instruction
      const createInstruction = parsedTxn.instructions.find(
        (ix: any) => ix.name === "create"
      );
      
      if (!createInstruction) return;
      
      // Type guard to ensure we have the right instruction type
      if (!('args' in createInstruction) || !('accounts' in createInstruction)) return;
      
      // Extract all the data from the create instruction
      const createData = createInstruction.args as any;
      const accounts = createInstruction.accounts as any[];
      
      // Map account names to their public keys
      const accountMap: { [key: string]: string } = {};
      
      // Handle both array format and object format for accounts
      if (Array.isArray(accounts)) {
        accounts.forEach((account: any) => {
          const pubkey = account.pubkey?.toString() || account.address?.toString() || account.publicKey?.toString() || "";
          accountMap[account.name] = pubkey;
        });
      } else if (typeof createInstruction.accounts === 'object') {
        // If accounts is an object with named properties
        Object.entries(createInstruction.accounts).forEach(([name, value]: [string, any]) => {
          if (typeof value === 'string') {
            accountMap[name] = value;
          } else if (value && typeof value === 'object' && 'toString' in value) {
            accountMap[name] = value.toString();
          }
        });
      }
      
      // Check for CreateEvent in the events
      const createEvent = parsedTxn.events?.find((e: any) => e.name === 'CreateEvent');
      
      const tokenData: CreateTokenData = {
        name: createData.name || "",
        symbol: createData.symbol || "",
        uri: createData.uri || "",
        mint: accountMap.mint || createEvent?.data?.mint || "",
        mintAuthority: accountMap.mintAuthority || accountMap.mint_authority || "",
        bondingCurve: accountMap.bondingCurve || accountMap.bonding_curve || createEvent?.data?.bonding_curve || "",
        associatedBondingCurve: accountMap.associatedBondingCurve || accountMap.associated_bonding_curve || "",
        global: accountMap.global || "",
        mplTokenMetadata: accountMap.mplTokenMetadata || accountMap.mpl_token_metadata || "",
        metadata: accountMap.metadata || "",
        user: accountMap.user || createEvent?.data?.user || "",
        timestamp: new Date().toISOString(),
        signature: txn.transaction.signatures[0],
        slot: data.slot,
      };
      
      // Fetch off-chain metadata
      if (tokenData.uri) {
        const offChainMetadata = await fetchTokenMetadata(tokenData.uri);
        if (offChainMetadata) {
          tokenData.offChainMetadata = offChainMetadata;
        }
      }
      
      console.log(
        `[NEW TOKEN CREATED]`,
        new Date(),
        "\n",
        JSON.stringify({
          ...tokenData,
          pumpFunUrl: `https://pump.fun/coin/${tokenData.mint}`,
          solscanUrl: `https://solscan.io/tx/${tokenData.signature}`,
          shyftUrl: `https://translator.shyft.to/tx/${tokenData.signature}`
        }, null, 2) + "\n"
      );
      
      // Save to database
      try {
        const saveData = {
          Ca: tokenData.mint,
          mint: tokenData.mint,
          signature: tokenData.signature,
          timestamp: tokenData.timestamp,
          creator: tokenData.user,
          name: tokenData.name,
          symbol: tokenData.symbol,
          metadata: {
            uri: tokenData.uri,
            bondingCurve: tokenData.bondingCurve,
            mintAuthority: tokenData.mintAuthority,
            associatedBondingCurve: tokenData.associatedBondingCurve,
            global: tokenData.global,
            mplTokenMetadata: tokenData.mplTokenMetadata,
            metadataAccount: tokenData.metadata,
            slot: tokenData.slot,
            offChainMetadata: tokenData.offChainMetadata
          }
        };
        
        await savePumpfunToken(saveData);
        console.log(`💾 New token saved to database with metadata`);
      } catch (error) {
        console.error(`❌ Failed to save token:`, error);
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
  console.log("Pump.fun New Token Mint Monitor V2");
  console.log("===================================");
  console.log("Program ID:", PUMP_FUN_PROGRAM_ID.toBase58());
  console.log("Features: On-chain + Off-chain metadata extraction");
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
      ix.programId.equals(PUMP_FUN_PROGRAM_ID)
    );
    
    const hydratedTx = hydrateLoadedAddresses(tx);
    const parsedInnerIxs = PUMP_FUN_IX_PARSER.parseTransactionWithInnerInstructions(hydratedTx);
    const pumpfunInnerIxs = parsedInnerIxs.filter((ix) =>
      ix.programId.equals(PUMP_FUN_PROGRAM_ID)
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