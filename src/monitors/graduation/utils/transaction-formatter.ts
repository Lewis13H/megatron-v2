import { VersionedTransactionResponse } from "@solana/web3.js";
import bs58 from "bs58";

export class TransactionFormatter {
  formTransactionFromJson(
    jsonData: any,
    timestamp: number
  ): VersionedTransactionResponse {
    try {
      // Handle signature
      const signature = jsonData.signature
        ? bs58.encode(jsonData.signature)
        : jsonData.transaction?.signatures?.[0] || "";

      // Format account keys
      const accountKeys = jsonData.transaction?.message?.accountKeys?.map(
        (key: any) => {
          if (typeof key === "string") return key;
          if (key instanceof Uint8Array || Buffer.isBuffer(key)) {
            return bs58.encode(key);
          }
          return key;
        }
      ) || [];

      // Format transaction - return a proper VersionedTransactionResponse
      const formattedTx: VersionedTransactionResponse = {
        slot: jsonData.slot || 0,
        transaction: {
          signatures: [signature],
          message: jsonData.transaction?.message || {},
        } as any,
        meta: jsonData.meta || {
          err: null,
          fee: 0,
          preBalances: [],
          postBalances: [],
          innerInstructions: [],
          logMessages: [],
          preTokenBalances: [],
          postTokenBalances: [],
          rewards: [],
          loadedAddresses: {
            readonly: [],
            writable: [],
          },
        },
        blockTime: Math.floor(timestamp / 1000),
        version: jsonData.transaction?.version || "legacy",
      };

      return formattedTx;
    } catch (error) {
      console.error("Error formatting transaction:", error);
      throw error;
    }
  }
}