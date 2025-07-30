import { Connection, PublicKey } from '@solana/web3.js';

async function checkTransaction(signature: string) {
  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  
  console.log(`\nChecking transaction: ${signature}\n`);
  console.log(`Solscan: https://solscan.io/tx/${signature}`);
  console.log(`Shyft: https://translator.shyft.to/tx/${signature}\n`);
  
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0
    });
    
    if (!tx) {
      console.log('Transaction not found');
      return;
    }
    
    console.log('Transaction Details:');
    console.log('- Slot:', tx.slot);
    console.log('- Block Time:', new Date(tx.blockTime! * 1000).toISOString());
    console.log('- Fee:', tx.meta?.fee);
    
    console.log('\nInstructions:');
    tx.transaction.message.instructions.forEach((ix, index) => {
      console.log(`\n[${index}] Program: ${ix.programId.toString()}`);
      if ('parsed' in ix) {
        console.log('   Type:', ix.parsed?.type);
        console.log('   Info:', JSON.stringify(ix.parsed?.info, null, 2));
      } else {
        console.log('   Data:', ix.data);
        console.log('   Accounts:', ix.accounts.map(a => a.toString()));
      }
    });
    
    // Check for Raydium Launchpad program
    const raydiumLaunchpadProgram = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
    const hasRaydiumLaunchpad = tx.transaction.message.instructions.some(
      ix => ix.programId.toString() === raydiumLaunchpadProgram
    );
    
    console.log(`\nHas Raydium Launchpad instruction: ${hasRaydiumLaunchpad}`);
    
    // Check post token balances for new mints
    if (tx.meta?.postTokenBalances) {
      console.log('\nToken Mints in Transaction:');
      const mints = new Set(tx.meta.postTokenBalances.map(tb => tb.mint));
      mints.forEach(mint => console.log(`- ${mint}`));
    }
    
  } catch (error) {
    console.error('Error fetching transaction:', error);
  }
}

// Run if called directly with a signature
if (require.main === module) {
  const signature = process.argv[2];
  if (!signature) {
    console.log('Usage: npm run check-tx <signature>');
    console.log('Example: npm run check-tx 2vrdRoRK7eMejTRbQ6uc2DNRn7sTPo751DqnpUiouFkeMoQLXn1LVYAQQgWujKbvNmrSrwLgLecw9SjTnT42LTij');
    process.exit(1);
  }
  
  // Validate signature length
  if (signature.length !== 88 && signature.length !== 87) {
    console.error(`Error: Invalid signature length (${signature.length} characters). Solana signatures should be 87-88 characters.`);
    console.error('Make sure to copy the complete signature.');
    process.exit(1);
  }
  
  checkTransaction(signature)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { checkTransaction };