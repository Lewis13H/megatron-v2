import { getDbPool } from './connection';
import 'dotenv/config';

async function resetPoolReserves() {
  const pool = getDbPool();
  
  try {
    console.log('Resetting Pump.fun pool reserve data...\n');

    // Reset all pump.fun pool reserves to NULL
    const result = await pool.query(`
      UPDATE pools
      SET 
        virtual_sol_reserves = NULL,
        virtual_token_reserves = NULL,
        real_sol_reserves = NULL,
        real_token_reserves = NULL,
        bonding_curve_progress = NULL,
        updated_at = NOW()
      WHERE platform = 'pumpfun'
      RETURNING pool_address, bonding_curve_address
    `);

    console.log(`✅ Reset ${result.rowCount} Pump.fun pools`);
    console.log('\nNow run the account monitor to get fresh data from the blockchain.');
    
  } catch (error) {
    console.error('Error resetting pool reserves:', error);
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  resetPoolReserves();
}