export function pumpFunParsedTransaction(parsedInstruction: any, txn: any){
  const instructions = parsedInstruction.instructions.find((x: any)=> x.name === "create");
   if(!instructions) return;
  let output = {};

    output = {
      ...txn,
      meta: {
        ...txn.meta,
        innerInstructions: parsedInstruction.inner_ixs,
      },
      transaction: {
        ...txn.transaction,
        message: {
          ...txn.transaction.message,
          instructions : parsedInstruction.instructions,
          compiledInstructions: parsedInstruction.instructions,
        },
      }
    }
  

  return output;
}

export function parseSwapTransactionOutput(parsedInstruction: any) {
  const innerInstructions = parsedInstruction.inner_ixs ?? [];

  const swapInstruction = innerInstructions.find(
    (ix: any) => ix.name === 'buy' || ix.name === 'sell'
  );

  if (!swapInstruction) return;
  const { name: type, accounts = [], args = {} } = swapInstruction;
  const baseAmountIn = args?.amount;

  const bondingCurve = accounts.find((a: any) => a.name === 'bondingCurve')?.pubkey;
  const userPubkey = accounts.find((a: any) => a.name === 'user')?.pubkey;
  const mint = accounts.find((a: any) => a.name === 'mint')?.pubkey;

  const transferInstruction = innerInstructions.find(
    (ix: any) => ix.name === 'transfer' && ix.args?.amount !== baseAmountIn
  );
  
  // For buy transactions, find all SOL transfers and sum them
  // For sell transactions, find the SOL transfer to the user
  const solTransfers = innerInstructions.filter(
    (ix: any) => {
      // System program transfers have lamports
      const isSystemTransfer = ix.programId === '11111111111111111111111111111111' || 
                              ix.programId?.toString() === '11111111111111111111111111111111';
      return ix.name === 'transfer' && isSystemTransfer && ix.args?.lamports !== undefined;
    }
  );
  
  let alternativeAmountOut;
  
  if (type === 'buy') {
    // For buys, we'll handle this differently - see below
    alternativeAmountOut = 0; // Will be set properly below
  } else {
    // For sells, find the SOL transfer (there's usually only one)
    // If multiple, take the largest one
    if (solTransfers.length > 0) {
      const sortedTransfers = solTransfers.sort((a: any, b: any) => 
        (b.args?.lamports || 0) - (a.args?.lamports || 0)
      );
      alternativeAmountOut = sortedTransfers[0]?.args?.lamports;
    }
  }
  // First try to get the amount from the event data (most accurate)
  const solEventAmount = parsedInstruction?.events?.[0]?.data?.sol_amount || 
                        parsedInstruction?.events?.[0]?.solAmount || 
                        parsedInstruction?.events?.[0]?.data?.solAmount;
  
  // If no event data, find the main transfer (largest non-fee transfer)
  if (!solEventAmount && type === 'buy' && solTransfers.length > 0) {
    // Sort transfers by amount and pick the largest one (main payment)
    const sortedTransfers = solTransfers.sort((a: any, b: any) => 
      (b.args?.lamports || 0) - (a.args?.lamports || 0)
    );
    alternativeAmountOut = sortedTransfers[0]?.args?.lamports;
  }
  
  
  const outAmount = solEventAmount ?? alternativeAmountOut;


  const isBuy = type === 'buy';
  const inAmount = isBuy ? outAmount : baseAmountIn;
  const finalOutAmount = isBuy ? baseAmountIn : outAmount;

  return {
    type,
    user: userPubkey,
    mint,
    bonding_curve: bondingCurve,
    in_amount: inAmount,
    out_amount: finalOutAmount,
  };
}