import { getDbPool } from './connection';

async function checkGraduatedPools() {
  const dbPool = getDbPool();
  
  try {
    const query = `
      SELECT 
        p.pool_address,
        p.status,
        p.real_sol_reserves / 1e9 as real_sol,
        p.real_token_reserves / 1e6 as real_tokens,
        p.virtual_sol_reserves / 1e9 as virtual_sol,
        t.symbol,
        t.name,
        t.is_graduated,
        p.updated_at
      FROM pools p
      JOIN tokens t ON p.token_id = t.id
      WHERE p.platform = 'raydium_launchpad'
        AND p.real_sol_reserves IS NOT NULL
      ORDER BY p.real_sol_reserves DESC
      LIMIT 20;
    `;
    
    const result = await dbPool.query(query);
    
    console.log('\n=== RAYDIUM LAUNCHLAB POOL STATUS ===');
    console.log('Graduation threshold: 85 SOL\n');
    
    let graduatedCount = 0;
    
    for (const row of result.rows) {
      const solAmount = parseFloat(row.real_sol);
      const isGraduated = solAmount >= 85;
      if (isGraduated) graduatedCount++;
      
      console.log(`Pool: ${row.pool_address}`);
      console.log(`Token: ${row.symbol || 'Unknown'} (${row.name || 'Unnamed'})`);
      console.log(`Status: ${row.status}`);
      console.log(`Real SOL: ${solAmount.toFixed(2)} SOL ${isGraduated ? '✅ SHOULD BE GRADUATED' : '❌ Not graduated'}`);
      console.log(`Token graduated flag: ${row.is_graduated}`);
      console.log(`Virtual SOL: ${parseFloat(row.virtual_sol).toFixed(2)} SOL`);
      console.log(`Updated: ${row.updated_at}\n`);
    }
    
    console.log(`\nSUMMARY: ${graduatedCount} out of ${result.rows.length} pools have reached 85 SOL threshold`);
    
    // Check for any pools marked as graduated
    const graduatedQuery = `
      SELECT COUNT(*) as graduated_count
      FROM pools p
      WHERE p.platform = 'raydium_launchpad'
        AND p.status = 'graduated';
    `;
    
    const graduatedResult = await dbPool.query(graduatedQuery);
    console.log(`Pools marked as graduated in DB: ${graduatedResult.rows[0].graduated_count}`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbPool.end();
  }
}

checkGraduatedPools();