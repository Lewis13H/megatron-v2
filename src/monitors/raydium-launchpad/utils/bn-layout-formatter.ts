import { PublicKey } from "@solana/web3.js";
import { isObject } from "lodash";
import BN from "bn.js";

export function bnLayoutFormatter(obj: any) {
  for (const key in obj) {
    if (obj[key]?.constructor?.name === "PublicKey") {
      obj[key] = (obj[key] as PublicKey).toBase58();
    } else if (obj[key]?.constructor?.name === "BN") {
      obj[key] = obj[key].toString();
    } else if (obj[key]?.constructor?.name === "BigInt") {
      obj[key] = obj[key].toString();
    } else if (obj[key]?.constructor?.name === "Buffer") {
      obj[key] = (obj[key] as Buffer).toString("base64");
    } else if (typeof obj[key] === 'string' && /^[0-9a-fA-F]+$/.test(obj[key]) && obj[key].length % 2 === 0 && obj[key].length > 2) {
      // This looks like a hex string representing a number
      // Convert hex to BN and then to string
      try {
        const bn = new BN(obj[key], 16);
        obj[key] = bn.toString();
      } catch (e) {
        // If conversion fails, keep original value
      }
    } else if (isObject(obj[key])) {
      bnLayoutFormatter(obj[key]);
    } else {
      obj[key] = obj[key];
    }
  }
}