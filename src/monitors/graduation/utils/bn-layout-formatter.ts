import { PublicKey } from "@solana/web3.js";

export function bnLayoutFormatter(obj: any) {
  if (!obj) return;
  
  for (const key in obj) {
    if (obj[key]?.constructor?.name === "PublicKey") {
      obj[key] = (obj[key] as PublicKey).toBase58();
    } else if (obj[key]?.constructor?.name === "BN") {
      obj[key] = Number(obj[key].toString());
    } else if (obj[key]?.constructor?.name === "BigInt") {
      obj[key] = Number(obj[key].toString());
    } else if (obj[key]?.constructor?.name === "Buffer") {
      obj[key] = (obj[key] as Buffer).toString("base64");
    } else if (obj[key] && typeof obj[key] === "object") {
      bnLayoutFormatter(obj[key]);
    }
  }
}