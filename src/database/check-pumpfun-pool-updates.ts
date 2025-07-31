import { Pool } from 'pg';
import { getDbPool } from './connection';
import 'dotenv/config';

async function checkPumpfunPoolUpdates() {
  const pool = getDbPool();
  
  try {
    console.log('Checking Pump.fun pool updates in database...\n');

    // 1. Check pools with bonding curve data
    const poolsResult = await pool.query(`
      SELECT 
        p.id,
        p.pool_address,
        p.bonding_curve_address,
        p.virtual_sol_reserves,
        p.virtual_token_reserves,
        p.real_sol_reserves,
        p.real_token_reserves,
        p.bonding_curve_progress,
        p.status,
        p.created_at,
        p.updated_at,
        t.symbol,
        t.name,
        t.mint_address
      FROM pools p
      JOIN tokens t ON p.token_id = t.id
      WHERE p.platform = 'pumpfun'
        AND (p.virtual_sol_reserves IS NOT NULL 
          OR p.real_sol_reserves IS NOT NULL
          OR p.bonding_curve_progress IS NOT NULL)
      ORDER BY p.updated_at DESC
      LIMIT 10
    `);

    if (poolsResult.rows.length === 0) {
      console.log('❌ No Pump.fun pools with reserve data found!');
      console.log('\nPossible reasons:');
      console.log('1. The account monitor hasn\'t updated any pools yet');
      console.log('2. The bonding curve addresses in the database don\'t match the ones being monitored');
      console.log('3. The mint addresses are missing from the account data');
      
      // Check if there are any pools at all
      const allPoolsResult = await pool.query(`
        SELECT COUNT(*) as count FROM pools WHERE platform = 'pumpfun'
      `);
      console.log(`\nTotal Pump.fun pools in database: ${allPoolsResult.rows[0].count}`);
      
      // Check a sample of pools
      const samplePools = await pool.query(`
        SELECT 
          p.pool_address,
          p.bonding_curve_address,
          t.mint_address,
          t.symbol
        FROM pools p
        JOIN tokens t ON p.token_id = t.id
        WHERE p.platform = 'pumpfun'
        LIMIT 5
      `);
      
      if (samplePools.rows.length > 0) {
        console.log('\nSample of existing pools:');
        samplePools.rows.forEach((p, i) => {
          console.log(`${i + 1}. ${p.symbol || 'Unknown'}`);
          console.log(`   Pool: ${p.pool_address}`);
          console.log(`   Bonding Curve: ${p.bonding_curve_address || 'Not set'}`);
          console.log(`   Mint: ${p.mint_address}`);
        });
      }
      
      return;
    }

    console.log(`📊 Found ${poolsResult.rows.length} pools with reserve data:\n`);

    poolsResult.rows.forEach((pool, index) => {
      console.log(`${index + 1}. ${pool.symbol || 'Unknown'} (${pool.name || 'Unknown'})`);
      console.log(`   Mint: ${pool.mint_address}`);
      console.log(`   Bonding Curve: ${pool.bonding_curve_address || 'Not set'}`);
      console.log(`   Progress: ${pool.bonding_curve_progress ? parseFloat(pool.bonding_curve_progress).toFixed(2) + '%' : 'Not calculated'}`);
      console.log(`   Status: ${pool.status}`);
      
      if (pool.virtual_sol_reserves) {
        const virtualSol = parseFloat(pool.virtual_sol_reserves) / 1e9;
        const virtualToken = parseFloat(pool.virtual_token_reserves) / 1e6;
        console.log(`   Virtual Reserves: ${virtualSol.toFixed(6)} SOL / ${virtualToken.toFixed(2)} tokens`);
      }
      
      if (pool.real_sol_reserves) {
        const realSol = parseFloat(pool.real_sol_reserves) / 1e9;
        const realToken = parseFloat(pool.real_token_reserves) / 1e6;
        console.log(`   Real Reserves: ${realSol.toFixed(6)} SOL / ${realToken.toFixed(2)} tokens`);
      }
      
      console.log(`   Created: ${pool.created_at}`);
      console.log(`   Last Updated: ${pool.updated_at}`);
      
      // Check if it's being updated
      const timeDiff = Date.now() - new Date(pool.updated_at).getTime();
      const minutesAgo = Math.floor(timeDiff / 60000);
      if (minutesAgo < 5) {
        console.log(`   ✅ Recently updated (${minutesAgo} minutes ago)`);
      } else {
        console.log(`   ⚠️  Last updated ${minutesAgo} minutes ago`);
      }
      console.log('');
    });

    // 2. Check pools that have been updated vs not updated
    const updateStatsResult = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE updated_at > created_at) as updated_count,
        COUNT(*) FILTER (WHERE updated_at = created_at) as not_updated_count,
        COUNT(*) as total_count
      FROM pools 
      WHERE platform = 'pumpfun'
    `);

    const updateStats = updateStatsResult.rows[0];
    console.log('\n📈 Update Statistics:');
    console.log(`Total Pump.fun pools: ${updateStats.total_count}`);
    console.log(`Pools with updates: ${updateStats.updated_count}`);
    console.log(`Pools never updated: ${updateStats.not_updated_count}`);

    // 3. Check for graduated pools
    const graduatedResult = await pool.query(`
      SELECT COUNT(*) as count
      FROM pools 
      WHERE platform = 'pumpfun' AND status = 'graduated'
    `);

    console.log(`\n🎓 Graduated pools: ${graduatedResult.rows[0].count}`);

    console.log('\n✅ Database check complete!');

  } catch (error) {
    console.error('Error checking database:', error);
  } finally {
    await pool.end();
  }
}

// Run the check
checkPumpfunPoolUpdates();