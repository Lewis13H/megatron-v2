import base58 from "bs58";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import { bnLayoutFormatter } from "./bn-layout-formatter";
import raydiumLaunchpadIdl from "../idls/raydium_launchpad.json";

const coder = new BorshAccountsCoder(raydiumLaunchpadIdl as Idl);

export async function decodeRaydiumLaunchpadTxnData(data: any) {
  if (!data || !data.account || !data.account.account) return;

  const dataTx = data.account.account;

  const signature = dataTx.txnSignature ? base64ToBase58(dataTx.txnSignature) : null;
  const pubKey = dataTx.pubkey ? base64ToBase58(dataTx.pubkey) : null;
  const owner = dataTx.owner ? base64ToBase58(dataTx.owner) : null;

  let parsedAccount;
  try {
    parsedAccount = coder.decodeAny(dataTx?.data);
    bnLayoutFormatter(parsedAccount);
  } catch (error) {
    console.error("Failed to decode pool state:", error);
  }

  return {
    signature,
    pubKey,
    owner,
    parsedAccount
  };
}

function base64ToBase58(data: string) {
  return base58.encode(Buffer.from(data, 'base64'));
}