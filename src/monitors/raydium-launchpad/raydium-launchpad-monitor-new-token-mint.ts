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
import { PublicKey, VersionedTransactionResponse, Connection } from "@solana/web3.js";
import { Idl, BorshAccountsCoder } from "@coral-xyz/anchor";
import { SolanaParser } from "@shyft-to/solana-transaction-parser";
import { SubscribeRequestPing } from "@triton-one/yellowstone-grpc/dist/types/grpc/geyser";
import { TransactionFormatter } from "./utils/transaction-formatter";
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import raydiumLaunchpadIdl from "./idls/raydium_launchpad.json";
import { saveRaydiumToken } from "../../database/monitor-integration";
import { getDbPool } from "../../database";

// This monitor focuses on detecting new token launches on Raydium Launchpad
// It captures the initial token metadata and pool creation details
// The account monitor (raydium-launchpad-account-monitor.ts) handles all subsequent price updates

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
  externalUrl?: string;
  attributes?: Array<{ trait_type: string; value: string | number }>;
  [key: string]: any;
}

const TXN_FORMATTER = new TransactionFormatter();
const RAYDIUM_LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"
);

// Initialize account decoder
const coder = new BorshAccountsCoder(raydiumLaunchpadIdl as Idl);
const RAYDIUM_LAUNCHPAD_IX_PARSER = new SolanaParser([]);
RAYDIUM_LAUNCHPAD_IX_PARSER.addParserFromIdl(
  RAYDIUM_LAUNCHPAD_PROGRAM_ID.toBase58(),
  raydiumLaunchpadIdl as Idl
);

// Metaplex Token Metadata Program
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// Solana connection for fetching metadata
const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed"
);

// Function to get metadata PDA for a token mint
function findMetadataPda(mint: PublicKey): PublicKey {
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  return metadataPda;
}

// Function to fetch token metadata
async function fetchTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
  try {
    const mint = new PublicKey(mintAddress);
    const metadataPda = findMetadataPda(mint);
    
    console.log(`📡 Fetching on-chain metadata for mint: ${mintAddress}`);
    
    const metadataAccount = await connection.getAccountInfo(metadataPda);
    if (!metadataAccount) {
      console.log("❌ No metadata account found");
      return null;
    }
    
    // Parse metadata account - proper Metaplex format
    const data = metadataAccount.data;
    
    // Skip discriminator (1) + key (1)
    let offset = 1 + 1;
    
    // Skip update authority (32)
    offset += 32;
    
    // Skip mint (32)
    offset += 32;
    
    // Debug the exact position
    console.log(`Starting to parse metadata at offset ${offset}`);
    console.log('Next 50 bytes:', data.slice(offset, offset + 50).toString('hex'));
    
    // Based on previous debug, the format seems to be:
    // [3 bytes padding][1 byte that we're losing][32 bytes name]...
    // We need to skip only 3 bytes, not 4
    
    // Skip 3 bytes of padding (not 4!)
    offset += 3;
    
    // Read name (starting from the 4th byte which contains the first character)
    let name = '';
    // First, get the byte we were missing
    const firstChar = data[offset];
    if (firstChar >= 32 && firstChar <= 126) {
      name += String.fromCharCode(firstChar);
    }
    offset += 1;
    
    // Now read the rest of the name (31 more bytes)
    for (let i = 0; i < 31; i++) {
      const byte = data[offset + i];
      if (byte >= 32 && byte <= 126) {
        name += String.fromCharCode(byte);
      } else if (byte === 0) {
        break;
      }
    }
    name = name.trim();
    offset += 31;
    
    // Skip 3 bytes of padding before symbol (not 4!)
    offset += 3;
    
    // Read symbol - first character
    let symbol = '';
    const firstSymbolChar = data[offset];
    if (firstSymbolChar >= 32 && firstSymbolChar <= 126) {
      symbol += String.fromCharCode(firstSymbolChar);
    }
    offset += 1;
    
    // Rest of symbol (9 more bytes)
    for (let i = 0; i < 9; i++) {
      const byte = data[offset + i];
      if (byte >= 32 && byte <= 126) {
        symbol += String.fromCharCode(byte);
      } else if (byte === 0) {
        break;
      }
    }
    symbol = symbol.trim();
    offset += 9;
    
    // Skip 3 bytes of padding before URI (not 4!)
    offset += 3;
    
    // Read URI - first character
    let uri = '';
    const firstUriChar = data[offset];
    if (firstUriChar >= 32 && firstUriChar <= 126) {
      uri += String.fromCharCode(firstUriChar);
    }
    offset += 1;
    
    // Rest of URI (199 more bytes)
    for (let i = 0; i < 199; i++) {
      const byte = data[offset + i];
      if (byte >= 32 && byte <= 126) {
        uri += String.fromCharCode(byte);
      } else if (byte === 0) {
        break;
      }
    }
    uri = uri.trim();
    
    console.log(`✅ Found on-chain metadata: ${name || 'Unknown'} (${symbol || 'Unknown'})`);
    
    // Fetch off-chain metadata from URI
    if (uri && uri.length > 0) {
      try {
        // Clean the URI - remove null characters and non-printable characters
        const cleanedUri = uri.replace(/\u0000/g, '').replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
        
        // Handle different URI formats
        let fetchUrl = cleanedUri;
        
        // Fix common URI issues
        if (cleanedUri.startsWith('ttps://')) {
          fetchUrl = 'h' + cleanedUri;
        } else if (cleanedUri.startsWith('ttp://')) {
          fetchUrl = 'h' + cleanedUri;
        }
        
        // Handle IPFS URIs - use alternative gateways
        if (fetchUrl.startsWith('ipfs://')) {
          fetchUrl = fetchUrl.replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/');
        } else if (fetchUrl.includes('ipfs.io/ipfs/')) {
          // Replace ipfs.io with pinata gateway
          fetchUrl = fetchUrl.replace('ipfs.io/ipfs/', 'gateway.pinata.cloud/ipfs/');
        } else if (fetchUrl.includes('/ipfs/') && !fetchUrl.startsWith('http')) {
          fetchUrl = fetchUrl.replace('/ipfs/', 'https://gateway.pinata.cloud/ipfs/');
        } else if (!fetchUrl.startsWith('http://') && !fetchUrl.startsWith('https://')) {
          // Handle relative URIs - prepend https://
          if (fetchUrl.includes('.') && fetchUrl.includes('/')) {
            fetchUrl = `https://${fetchUrl}`;
          } else {
            console.log(`⚠️ Skipping invalid URI format: ${cleanedUri}`);
            return {
              name: name || 'Unknown',
              symbol: symbol || 'Unknown',
              metadataUri: cleanedUri
            };
          }
        }
        
        // Validate URL
        try {
          new URL(fetchUrl);
        } catch {
          console.log(`⚠️ Invalid URL after cleaning: ${fetchUrl}`);
          return {
            name: name || 'Unknown',
            symbol: symbol || 'Unknown',
            metadataUri: cleanedUri
          };
        }
        
        console.log(`📡 Fetching off-chain metadata from: ${fetchUrl}`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        const response = await fetch(fetchUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const offChainMetadata = await response.json() as TokenMetadata;
          console.log(`✅ Successfully fetched off-chain metadata`);
          return {
            ...offChainMetadata,
            name: name || offChainMetadata.name || 'Unknown',
            symbol: symbol || offChainMetadata.symbol || 'Unknown',
            onChainName: name,
            onChainSymbol: symbol,
            metadataUri: cleanedUri
          };
        }
      } catch (error) {
        console.error(`❌ Error fetching off-chain metadata:`, error);
      }
    }
    
    // Return on-chain metadata only
    return {
      name: name || 'Unknown',
      symbol: symbol || 'Unknown',
      metadataUri: uri ? uri.replace(/\u0000/g, '').trim() : ''
    };
  } catch (error) {
    console.error(`❌ Error fetching metadata:`, error);
    return null;
  }
}

async function fetchPoolAccountData(poolAddress: string) {
  try {
    const poolPubkey = new PublicKey(poolAddress);
    const accountInfo = await connection.getAccountInfo(poolPubkey);
    
    if (!accountInfo) {
      console.log("Pool account not found");
      return null;
    }
    
    // Decode the pool state
    const poolState = coder.decodeAny(accountInfo.data);
    
    if (poolState) {
      bnLayoutFormatter(poolState);
      return poolState;
    }
    
    return null;
  } catch (error) {
    console.error("Error fetching pool account:", error);
    return null;
  }
}

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("Starting Stream...")
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

      const parsedTxn = decodeRaydiumLaunchpad(txn);
      if (!parsedTxn) return;
      
      // Filter for initialize instructions only
      const initializeInstruction = parsedTxn.instructions?.find((ix: any) => ix.name === "initialize");
      if (!initializeInstruction) return;
      
      // Debug: Log the full instruction to understand structure
      console.log("Initialize instruction accounts:", initializeInstruction.accounts?.map((acc: any) => ({
        name: acc.name,
        pubkey: acc.pubkey
      })));
      
      // Extract token information from the initialize instruction
      const poolState = initializeInstruction.accounts?.find((acc: any) => acc.name === "pool_state")?.pubkey;
      const baseTokenMint = initializeInstruction.accounts?.find((acc: any) => acc.name === "base_mint")?.pubkey;
      const quoteTokenMint = initializeInstruction.accounts?.find((acc: any) => acc.name === "quote_mint")?.pubkey;
      const creator = initializeInstruction.accounts?.find((acc: any) => acc.name === "creator")?.pubkey;
      
      // Skip if we don't have the required token mint
      if (!baseTokenMint) {
        console.log("Warning: baseTokenMint not found in instruction accounts");
        return;
      }
      
      // Fetch token metadata
      let tokenMetadata: TokenMetadata | null = null;
      if (baseTokenMint) {
        tokenMetadata = await fetchTokenMetadata(baseTokenMint.toString());
      }
      
      // Clean the tokenMetadata to ensure no null characters
      if (tokenMetadata && tokenMetadata.metadataUri) {
        tokenMetadata.metadataUri = tokenMetadata.metadataUri.replace(/\u0000/g, '').trim();
      }
      
      // Debug: Log the instruction args to understand the format
      console.log("Initialize instruction args:", JSON.stringify(initializeInstruction.args, null, 2));
      
      // Fetch the pool account data to get accurate virtual reserves
      let poolAccountData = null;
      if (poolState) {
        // Wait a bit for the account to be created
        await new Promise(resolve => setTimeout(resolve, 1000));
        poolAccountData = await fetchPoolAccountData(poolState.toString());
        if (poolAccountData) {
          console.log("Pool account data fetched successfully");
          console.log(`  Virtual base (tokens): ${poolAccountData.virtual_base}`);
          console.log(`  Virtual quote (SOL): ${poolAccountData.virtual_quote}`);
        }
      }
      
      // Calculate price from virtual reserves
      let priceUsd = null;
      let priceInSol = null;
      
      try {
        // Use actual pool account data if available
        if (poolAccountData && poolAccountData.virtual_base && poolAccountData.virtual_quote) {
          const virtualTokenReserves = parseFloat(poolAccountData.virtual_base);
          const virtualSolReserves = parseFloat(poolAccountData.virtual_quote);
          
          // Price calculation: SOL has 9 decimals, tokens have 6 decimals
          priceInSol = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6);
          
          console.log(`Initial price calculation from pool virtual reserves:`);
          console.log(`  Virtual SOL reserves: ${virtualSolReserves} lamports (${(virtualSolReserves / 1e9).toFixed(6)} SOL)`);
          console.log(`  Virtual token reserves: ${virtualTokenReserves} smallest units (${(virtualTokenReserves / 1e6).toFixed(2)} tokens)`);
          console.log(`  Initial price: ${priceInSol.toExponential(6)} SOL per token`);
          
          // Calculate market cap
          const totalSupplyTokens = 1_000_000_000; // 1B tokens
          const marketCapSol = priceInSol * totalSupplyTokens;
          console.log(`  Initial market cap: ${marketCapSol.toFixed(2)} SOL`);
        } else {
          // If pool account data not available, we'll wait for the account monitor to provide pricing
          console.log("Pool account data not available yet. Initial price will be set by account monitor.");
        }
        
        // Calculate USD price if we have SOL price
        if (priceInSol && priceInSol > 0) {
          const dbPool = getDbPool();
          const solPriceResult = await dbPool.query(
            'SELECT price_usd FROM sol_usd_prices ORDER BY price_time DESC LIMIT 1'
          );
          if (solPriceResult.rows.length > 0) {
            const solPrice = parseFloat(solPriceResult.rows[0].price_usd);
            priceUsd = priceInSol * solPrice;
            console.log(`USD price: ${priceInSol} SOL * $${solPrice} = $${priceUsd}`);
          }
        }
      } catch (error) {
        console.error('Error calculating price:', error);
      }
      
      const output = {
        timestamp: new Date().toISOString(),
        signature: txn.transaction.signatures[0],
        poolState: poolState?.toString(),
        baseTokenMint: baseTokenMint?.toString(),
        quoteTokenMint: quoteTokenMint?.toString() === 'So11111111111111111111111111111111111111112' ? 'SOL' : quoteTokenMint?.toString(),
        initialPrice: priceInSol ? priceInSol.toString() : null,
        initialPriceUsd: priceUsd,
        creator: creator?.toString() || 'unknown',
        tokenMetadata: tokenMetadata,
        solscanUrl: `https://solscan.io/tx/${txn.transaction.signatures[0]}`,
        shyftUrl: `https://translator.shyft.to/tx/${txn.transaction.signatures[0]}`
      };
      
      console.log(
        new Date(),
        ":",
        `New token mint detected`,
        `\n💰 Initial Price:` + (priceInSol ? ` ${priceInSol.toExponential(6)} SOL` : ' Pending (will be set by account monitor)') + (priceUsd ? ` ($${priceUsd.toExponential(6)} USD)` : ''),
        `\n📊 Token: ${tokenMetadata?.symbol || 'Unknown'} (${tokenMetadata?.name || 'Unknown'})`,
        `\n🏊 Pool: ${poolState?.toString() || 'Unknown'}`,
        `\n${JSON.stringify(output, null, 2)}\n`
      );
      
      // Save to database
      saveRaydiumToken(output).catch(error => {
        console.error("Failed to save token to database:", error);
      });
      
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
  console.log("Raydium Launchpad New Token Monitor (with Metadata)");
  console.log("====================================================");
  console.log("Program ID:", RAYDIUM_LAUNCHPAD_PROGRAM_ID.toBase58());
  console.log("Features: On-chain + Off-chain metadata extraction");
  console.log("Monitoring for initialize instructions...\n");
  
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

subscribeCommand(client, req);


function decodeRaydiumLaunchpad(tx: VersionedTransactionResponse) {
  if (tx.meta?.err) return;

  try {
    const parsedIxs = RAYDIUM_LAUNCHPAD_IX_PARSER.parseTransactionData(
      tx.transaction.message,
      tx.meta!.loadedAddresses
    );

    const raydiumLaunchpadIxs = parsedIxs.filter((ix) =>
      ix.programId.equals(RAYDIUM_LAUNCHPAD_PROGRAM_ID)
    );

    if (raydiumLaunchpadIxs.length === 0) return;

    const cleanedInstructions = raydiumLaunchpadIxs.filter((ix: any) => ix.name !== "unknown");

    const result = { instructions: cleanedInstructions };
    bnLayoutFormatter(result);

    return result;
  } catch (err) {
    // Silent error handling
  }
}