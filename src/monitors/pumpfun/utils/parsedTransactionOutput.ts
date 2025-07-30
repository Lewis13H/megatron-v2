export function parsedTransactionOutput(parsedInstructions: any[], formattedTransaction: any): any[] {
  const output: any[] = [];
  
  if (!parsedInstructions || parsedInstructions.length === 0) {
    return output;
  }

  // Process each parsed instruction
  for (const instruction of parsedInstructions) {
    if (instruction.programId === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P") {
      // Process Pump.fun instructions
      const eventData = {
        type: "pump_fun_event",
        programId: instruction.programId,
        info: {
          event_name: instruction.name,
          accounts: instruction.accounts,
          args: instruction.args,
          innerInstructions: instruction.innerInstructions
        },
        signature: formattedTransaction?.signature,
        timestamp: Date.now()
      };
      
      output.push(eventData);
      
      // Process inner instructions for buy/sell events
      if (instruction.innerInstructions && instruction.innerInstructions.length > 0) {
        for (const innerIx of instruction.innerInstructions) {
          if (innerIx.name === 'buy' || innerIx.name === 'sell') {
            output.push({
              type: "swap_event",
              programId: innerIx.programId,
              info: {
                event_name: innerIx.name,
                accounts: innerIx.accounts,
                args: innerIx.args
              },
              signature: formattedTransaction?.signature,
              timestamp: Date.now()
            });
          }
        }
      }
    }
  }
  
  return output;
}