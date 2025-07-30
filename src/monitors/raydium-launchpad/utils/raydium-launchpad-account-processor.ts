import { BorshAccountsCoder, utils } from "@coral-xyz/anchor";
import * as fs from 'fs';
import { bnLayoutFormatter } from "./bn-layout-formatter";

const program_idl = JSON.parse(fs.readFileSync('./src/monitors/raydium-launchpad/idls/raydium_launchpad.json', "utf8"));

const coder = new BorshAccountsCoder(program_idl);

export async function decodeRaydiumLaunchpadAccountData(data: any) {
  if (!data || !data.account || !data.account.account) return;

  const dataTx = data.account.account;

  const signature = dataTx.txnSignature ? base64ToBase58(dataTx.txnSignature) : null;
  const pubKey = dataTx.pubkey ? base64ToBase58(dataTx.pubkey) : null;
  const owner = dataTx.owner ? base64ToBase58(dataTx.owner) : null;

  let parsedAccount;
  let accountType;
  
  try {
    parsedAccount = coder.decodeAny(dataTx?.data);
    
    // The decoded account should have a type property from Anchor
    if (parsedAccount) {
      // Log all fields to understand the structure
      // console.log("🔍 Decoded account fields:", Object.keys(parsedAccount));
      
      // Try to determine the account type
      if (parsedAccount.constructor && parsedAccount.constructor.name) {
        accountType = parsedAccount.constructor.name;
        // console.log("   Constructor name:", accountType);
      }
      
      // Check if it has the expected PoolState fields
      const hasPoolStateFields = !!(
        parsedAccount.baseMint && 
        parsedAccount.quoteMint && 
        parsedAccount.baseVault &&
        parsedAccount.quoteVault &&
        parsedAccount.realBase !== undefined &&
        parsedAccount.realQuote !== undefined
      );
      
      if (hasPoolStateFields) {
        accountType = 'PoolState';
        console.log("   ✅ Identified as PoolState based on fields");
      }
      
      // Add the type to the parsed account for easier identification
      parsedAccount.accountType = accountType;
      
      bnLayoutFormatter(parsedAccount);
    }
  } catch (error) {
    console.error("Failed to decode account:", error);
    return null;
  }

  return {
    signature,
    pubKey,
    owner,
    parsedAccount,
    accountType
  };
}

function base64ToBase58(data: string) {
  return utils.bytes.bs58.encode(Buffer.from(data, 'base64'));
}