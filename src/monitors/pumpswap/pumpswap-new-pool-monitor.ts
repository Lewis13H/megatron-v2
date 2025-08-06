import "dotenv/config";
import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeRequestFilterTransactions
} from "@triton-one/yellowstone-grpc";
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { SolanaParser } from "@shyft-to/solana-transaction-parser";
import { TransactionFormatter } from "./utils/transaction-formatter";
import { SolanaEventParser } from "./utils/event-parser";
import { bnLayoutFormatter } from "./utils/bn-layout-formatter";
import pumpAmmIdl from "./idls/pump_amm_0.1.0.json";
import { pump_amm_formatter } from "./utils/pump-amm-txn-formatter";
import { monitorService } from "../../database";

// Suppress parser warnings
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.warn = (message?: any, ...optionalParams: any[]) => {
  if (
    typeof message === "string" &&
    message.includes("Parser does not matching the instruction args")
  ) {
    return;
  }
  originalConsoleWarn(message, ...optionalParams); 
};

console.log = (message?: any, ...optionalParams: any[]) => {
  if (
    typeof message === "string" &&
    message.includes("Parser does not matching the instruction args")
  ) {
    return; 
  }
  originalConsoleLog(message, ...optionalParams); 
};

console.error = (message?: any, ...optionalParams: any[]) => {
  if (
    typeof message === "string" &&
    message.includes("Parser does not matching the instruction args")
  ) {
    return;
  }
  originalConsoleError(message, ...optionalParams);
};

const TXN_FORMATTER = new TransactionFormatter();
const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
const PUMP_AMM_IX_PARSER = new SolanaParser([]);
PUMP_AMM_IX_PARSER.addParserFromIdl(
  PUMP_AMM_PROGRAM_ID.toBase58(),
  pumpAmmIdl as Idl
);
const PUMP_AMM_EVENT_PARSER = new SolanaEventParser([], console);
PUMP_AMM_EVENT_PARSER.addParserFromIdl(
  PUMP_AMM_PROGRAM_ID.toBase58(),
  pumpAmmIdl as Idl
);

async function handleStream(client: Client, args: SubscribeRequest) {
  console.log("🔍 Searching for Newly Created Pools on PumpSwap AMM");
  console.log("=" .repeat(80));
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

  // Handle updates
  stream.on("data", async (data) => {
    if (data?.transaction) {
      const txn = TXN_FORMATTER.formTransactionFromJson(
        data.transaction,
        Date.now()
      );

      const parsedTxn = decodePumpAmmTxn(txn);

      if (!parsedTxn) return;
      const formattedPAMMTxn = pump_amm_formatter(parsedTxn, txn);
      if (!formattedPAMMTxn) return;
      
      // Process and save the new pool
      await processNewPool(formattedPAMMTxn, txn);
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

function decodePumpAmmTxn(tx: VersionedTransactionResponse) {
  if (tx.meta?.err) return;

  const parsedIxs = PUMP_AMM_IX_PARSER.parseTransactionData(
    tx.transaction.message,
    tx.meta.loadedAddresses
  );

  const pumpAmmIxs = parsedIxs.filter((ix) =>
    ix.programId.equals(PUMP_AMM_PROGRAM_ID)
  );

  if (pumpAmmIxs.length === 0) return;
  const events = PUMP_AMM_EVENT_PARSER.parseEvent(tx);
  const result = { instructions: pumpAmmIxs, events };
  bnLayoutFormatter(result);
  return result;
}

async function processNewPool(formattedTxn: any, originalTxn: VersionedTransactionResponse) {
  try {
    // Extract create_pool instruction
    const createPoolIx = formattedTxn.transaction.message.compiledInstructions?.find(
      (ix: any) => ix.name === "create_pool"
    ) || formattedTxn.transaction.message.instructions?.find(
      (ix: any) => ix.name === "create_pool"
    );

    if (!createPoolIx) return;

    // Extract pool account from instruction accounts
    const poolAccount = createPoolIx.accounts?.find((acc: any) => acc.name === "pool");
    const baseMintAccount = createPoolIx.accounts?.find((acc: any) => acc.name === "base_mint");
    const quoteMintAccount = createPoolIx.accounts?.find((acc: any) => acc.name === "quote_mint");
    const lpMintAccount = createPoolIx.accounts?.find((acc: any) => acc.name === "lp_mint");
    const creatorAccount = createPoolIx.accounts?.find((acc: any) => acc.name === "creator");

    if (!poolAccount || !baseMintAccount) {
      console.log("⚠️ Missing required accounts in create_pool instruction");
      return;
    }

    const poolAddress = poolAccount.pubkey;
    let baseMint = baseMintAccount.pubkey;
    let quoteMint = quoteMintAccount?.pubkey || "So11111111111111111111111111111111111111112";
    
    // Swap if SOL is in base position (SOL should always be quote)
    if (baseMint === "So11111111111111111111111111111111111111112") {
      const temp = baseMint;
      baseMint = quoteMint;
      quoteMint = temp;
    }
    
    const lpMint = lpMintAccount?.pubkey;
    const creator = creatorAccount?.pubkey;
    const signature = originalTxn.transaction.signatures[0];

    console.log("\n" + "🆕".repeat(40));
    console.log("🏊 NEW PUMPSWAP POOL DETECTED!");
    console.log("─".repeat(80));
    console.log(`⏰ Time: ${new Date().toLocaleString()}`);
    console.log(`📝 Signature: ${signature}`);
    console.log(`💧 Pool Address: ${poolAddress}`);
    console.log(`🪙 Base Mint (Token): ${baseMint}`);
    console.log(`💰 Quote Mint: ${quoteMint}`);
    console.log(`🔄 LP Mint: ${lpMint || "N/A"}`);
    console.log(`👤 Creator: ${creator || "N/A"}`);
    console.log(`🔗 Transaction: https://translator.shyft.to/tx/${signature}`);
    console.log(`🔗 Solscan: https://solscan.io/account/${poolAddress}`);
    console.log("🆕".repeat(40) + "\n");

    // Save or update token as graduated
    await saveGraduatedToken(baseMint, poolAddress, signature, lpMint, creator);

  } catch (error) {
    console.error("Error processing new pool:", error);
  }
}

async function saveGraduatedToken(
  tokenMint: string, 
  poolAddress: string, 
  signature: string,
  lpMint?: string,
  creator?: string
) {
  try {
    // Check if token exists
    let token = await monitorService.getTokenByMint(tokenMint);
    
    if (token) {
      // Update existing token as graduated
      console.log(`✅ Token exists, marking as graduated: ${token.symbol}`);
      
      // Update graduation status
      await monitorService.updateGraduationStatus(
        tokenMint,
        signature,
        new Date()
      );

      // Save pool information
      await monitorService.savePool({
        pool_address: poolAddress,
        token_id: token.id,
        platform: 'pumpswap',
        creation_signature: signature,
        creation_timestamp: new Date(),
        is_active: true,
        metadata: {
          base_mint: tokenMint,
          quote_mint: "So11111111111111111111111111111111111111112",
          pool_type: 'graduated',
          status: 'active',
          lp_mint: lpMint || '',
          creator: creator || '',
          graduated: true
        }
      });

      console.log(`💾 Updated token ${token.symbol} as graduated with PumpSwap pool`);
      
    } else {
      // Create new token entry marked as graduated
      console.log(`🆕 New graduated token detected: ${tokenMint}`);
      
      const tokenId = await monitorService.saveToken({
        mint_address: tokenMint,
        symbol: 'UNKNOWN', // Will be updated when we get more info
        name: 'Unknown Token',
        platform: 'pumpfun', // Use pumpfun as platform since these are graduated tokens
        creator_address: creator || 'Unknown', // Add creator_address field
        creation_signature: signature, // Use pool creation signature as token creation signature
        creation_timestamp: new Date(),
        is_graduated: true,
        graduation_signature: signature,
        graduation_timestamp: new Date(),
        metadata: {
          graduated: true,
          graduation_timestamp: new Date().toISOString(),
          pumpswap_pool: poolAddress,
          pumpswap_lp_mint: lpMint,
          graduation_signature: signature,
          creator: creator || '',
          detected_via: 'pumpswap_pool_creation' // Track how we detected this
        }
      });

      // Save pool information
      await monitorService.savePool({
        pool_address: poolAddress,
        token_id: tokenId,
        platform: 'pumpswap',
        creation_signature: signature,
        creation_timestamp: new Date(),
        is_active: true,
        metadata: {
          base_mint: tokenMint,
          quote_mint: "So11111111111111111111111111111111111111112",
          pool_type: 'graduated',
          status: 'active',
          lp_mint: lpMint || '',
          creator: creator || '',
          graduated: true
        }
      });

      console.log(`💾 Created new graduated token entry with PumpSwap pool`);
    }

    console.log(`🎯 Token ${tokenMint} marked as GRADUATED in dashboard`);

  } catch (error) {
    console.error("Error saving graduated token:", error);
  }
}

// Main execution
const client = new Client(
  process.env.GRPC_URL!,
  process.env.X_TOKEN,
  undefined
);

const req: SubscribeRequest = {
  accounts: {},
  slots: {},
  transactions: {
    pumpAmm: {
      vote: false,
      failed: false,
      signature: undefined,
      accountInclude: [PUMP_AMM_PROGRAM_ID.toBase58()],
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
console.log("\n" + "=".repeat(80));
console.log("🏊 PUMPSWAP NEW POOL MONITOR");
console.log("=".repeat(80));
console.log("📍 Monitoring: New pool creation for graduated tokens");
console.log("🎯 Program: " + PUMP_AMM_PROGRAM_ID.toBase58());
console.log("=".repeat(80) + "\n");

subscribeCommand(client, req);