import { getDbPool } from './connection';

async function checkSpecificToken(mintAddress: string) {
  const dbPool = getDbPool();
  
  try {
    const query = `
      SELECT 
        t.mint_address,
        t.symbol,
        t.name,
        t.platform,
        t.creation_timestamp,
        t.is_graduated,
        p.pool_address,
        p.status as pool_status,
        p.real_sol_reserves / 1e9 as real_sol,
        p.real_token_reserves / 1e6 as real_tokens,
        p.virtual_sol_reserves / 1e9 as virtual_sol,
        p.virtual_token_reserves / 1e6 as virtual_tokens,
        CASE 
          WHEN p.real_token_reserves > 0 
          THEN (p.real_sol_reserves::numeric / 1e9) / (p.real_token_reserves::numeric / 1e6)
          ELSE NULL 
        END as price_per_token,
        CASE 
          WHEN p.real_token_reserves > 0 
          THEN ((p.real_sol_reserves::numeric / 1e9) / (p.real_token_reserves::numeric / 1e6)) * 1000000000
          ELSE NULL 
        END as market_cap_sol,
        p.created_at as pool_created,
        p.updated_at as pool_updated
      FROM tokens t
      LEFT JOIN pools p ON t.id = p.token_id
      WHERE t.mint_address = $1;
    `;
    
    const result = await dbPool.query(query, [mintAddress]);
    
    if (result.rows.length === 0) {
      console.log(`\nToken ${mintAddress} not found in database.\n`);
    } else {
      const token = result.rows[0];
      console.log('\n=== TOKEN DETAILS ===');
      console.log(`Mint: ${token.mint_address}`);
      console.log(`Symbol: ${token.symbol || 'Unknown'}`);
      console.log(`Name: ${token.name || 'Unnamed'}`);
      console.log(`Platform: ${token.platform}`);
      console.log(`Created: ${token.creation_timestamp}`);
      console.log(`Graduated: ${token.is_graduated}`);
      
      if (token.pool_address) {
        console.log('\n=== POOL DETAILS ===');
        console.log(`Pool: ${token.pool_address}`);
        console.log(`Status: ${token.pool_status}`);
        console.log(`Real SOL: ${token.real_sol ? parseFloat(token.real_sol).toFixed(4) : 'null'} SOL`);
        console.log(`Real Tokens: ${token.real_tokens ? parseFloat(token.real_tokens).toFixed(2) : 'null'} tokens`);
        console.log(`Virtual SOL: ${token.virtual_sol ? parseFloat(token.virtual_sol).toFixed(2) : 'null'} SOL`);
        console.log(`Virtual Tokens: ${token.virtual_tokens ? parseFloat(token.virtual_tokens).toFixed(2) : 'null'} tokens`);
        
        if (token.price_per_token) {
          console.log('\n=== PRICING ===');
          console.log(`Price: ${parseFloat(token.price_per_token).toFixed(10)} SOL per token`);
          console.log(`Market Cap: ${parseFloat(token.market_cap_sol).toFixed(2)} SOL`);
          
          // Calculate progress to graduation
          const progress = (parseFloat(token.real_sol) / 85) * 100;
          console.log(`Progress to graduation: ${progress.toFixed(2)}% (85 SOL target)`);
          
          // Additional calculations
          const tokensInPool = parseFloat(token.real_tokens);
          const totalSupply = 1000000000; // 1 billion
          const percentInPool = (tokensInPool / totalSupply) * 100;
          console.log(`\n=== SUPPLY ANALYSIS ===`);
          console.log(`Total Supply: 1,000,000,000 tokens`);
          console.log(`Tokens in pool: ${tokensInPool.toFixed(2)} (${percentInPool.toFixed(2)}%)`);
          console.log(`Tokens in circulation: ${(totalSupply - tokensInPool).toFixed(2)} (${(100 - percentInPool).toFixed(2)}%)`);
        }
      } else {
        console.log('\nNo pool found for this token.');
      }
    }
    
    // Check for any transactions
    const txQuery = `
      SELECT COUNT(*) as tx_count,
             SUM(CASE WHEN type = 'buy' THEN 1 ELSE 0 END) as buy_count,
             SUM(CASE WHEN type = 'sell' THEN 1 ELSE 0 END) as sell_count,
             SUM(CASE WHEN type = 'buy' THEN sol_amount ELSE 0 END) as total_buy_volume
      FROM transactions t
      JOIN tokens tok ON t.token_id = tok.id
      WHERE tok.mint_address = $1;
    `;
    
    const txResult = await dbPool.query(txQuery, [mintAddress]);
    if (txResult.rows[0] && parseInt(txResult.rows[0].tx_count) > 0) {
      console.log('\n=== TRADING ACTIVITY ===');
      console.log(`Total transactions: ${txResult.rows[0].tx_count}`);
      console.log(`Buys: ${txResult.rows[0].buy_count}`);
      console.log(`Sells: ${txResult.rows[0].sell_count}`);
      console.log(`Total buy volume: ${parseFloat(txResult.rows[0].total_buy_volume || 0).toFixed(4)} SOL`);
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbPool.end();
  }
}

// Check the specific token
const tokenMint = '7uB9AvqaDigasJcb6xYjA6xTPFp4dnwFiEv8YhdQbonk';
checkSpecificToken(tokenMint);