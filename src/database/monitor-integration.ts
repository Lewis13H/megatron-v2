import { pool } from './config';
import { PoolOperations } from './pool-operations';

interface TokenData {
  mint_address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  platform: 'pumpfun' | 'raydium_launchpad';
  creation_signature: string;
  creation_timestamp: Date;
  creator_address: string;
  initial_supply?: string;
  metadata?: any;
}

const poolOps = new PoolOperations(pool);

async function insertToken(tokenData: TokenData) {
  const client = await pool.connect();
  
  try {
    const query = `
      INSERT INTO tokens (
        mint_address, symbol, name, decimals, platform,
        creation_signature, creation_timestamp, creator_address,
        initial_supply, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (mint_address) DO UPDATE SET
        updated_at = NOW()
      RETURNING *
    `;
    
    const values = [
      tokenData.mint_address,
      tokenData.symbol || null,
      tokenData.name || null,
      tokenData.decimals || 6,
      tokenData.platform,
      tokenData.creation_signature,
      tokenData.creation_timestamp,
      tokenData.creator_address,
      tokenData.initial_supply || null,
      tokenData.metadata ? JSON.stringify(tokenData.metadata) : null
    ];
    
    const result = await client.query(query, values);
    return result.rows[0];
    
  } catch (error) {
    console.error('Error inserting token:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Integration functions to connect monitors to database
 * 
 * Usage in monitors:
 * 1. Import this file in your monitor
 * 2. Call the appropriate save function when new tokens are detected
 */

export async function saveRaydiumToken(monitorOutput: any) {
  try {
    // Validate required fields
    if (!monitorOutput.baseTokenMint) {
      console.error('Cannot save token: baseTokenMint is missing');
      return null;
    }
    
    if (!monitorOutput.signature) {
      console.error('Cannot save token: signature is missing');
      return null;
    }
    
    if (!monitorOutput.poolState) {
      console.error('Cannot save token: poolState is missing');
      return null;
    }
    
    // Extract and format the data from monitor output
    const formattedData = {
      timestamp: monitorOutput.timestamp || new Date().toISOString(),
      signature: monitorOutput.signature,
      poolState: monitorOutput.poolState,
      baseTokenMint: monitorOutput.baseTokenMint,
      quoteTokenMint: monitorOutput.quoteTokenMint,
      initialPrice: monitorOutput.initialPrice,
      initialLiquidity: monitorOutput.initialLiquidity,
      creator: monitorOutput.creator || 'unknown' // You may need to extract this from transaction
    };
    
    const tokenData: TokenData = {
      mint_address: formattedData.baseTokenMint,
      platform: 'raydium_launchpad',
      creation_signature: formattedData.signature,
      creation_timestamp: new Date(formattedData.timestamp),
      creator_address: formattedData.creator || 'unknown',
      metadata: {
        pool_state: formattedData.poolState,
        quote_token_mint: formattedData.quoteTokenMint,
        initial_price: formattedData.initialPrice,
        initial_liquidity: formattedData.initialLiquidity
      }
    };
    
    // Save token first
    const tokenResult = await insertToken(tokenData);
    console.log(`💾 Saved Raydium token to database: ${tokenResult.mint_address.substring(0, 10)}...`);
    
    // Now save the pool
    try {
      // Prepare pool data
      const poolData = {
        pool_address: formattedData.poolState,
        base_mint: formattedData.baseTokenMint,
        quote_mint: formattedData.quoteTokenMint === 'SOL' ? 'So11111111111111111111111111111111111111112' : formattedData.quoteTokenMint,
        platform: 'raydium_launchpad' as const,
        initial_price: formattedData.initialPrice,
        initial_quote_liquidity: formattedData.initialLiquidity ? String(formattedData.initialLiquidity) : undefined
      };
      
      const poolResult = await poolOps.insertPoolWithToken(poolData, formattedData.baseTokenMint);
      console.log(`💾 Saved Raydium pool to database: ${poolResult.pool_address.substring(0, 10)}...`);
    } catch (poolError) {
      console.error('Failed to save pool (may already exist):', poolError);
      // Don't fail the whole operation if pool save fails
    }
    
    return tokenResult;
  } catch (error) {
    console.error('Failed to save Raydium token:', error);
    // Don't throw, just return null to allow monitor to continue
    return null;
  }
}

export async function savePumpfunToken(monitorOutput: any) {
  try {
    // Handle different output formats from Pump.fun monitors
    const formattedData = {
      timestamp: monitorOutput.timestamp,
      signature: monitorOutput.signature,
      Ca: monitorOutput.Ca || monitorOutput.mint,
      symbol: monitorOutput.symbol,
      name: monitorOutput.name,
      creator: monitorOutput.creator || monitorOutput.user || 'unknown',
      bondingCurve: monitorOutput.bondingCurve || monitorOutput.bonding_curve,
      virtualSolReserves: monitorOutput.virtualSolReserves,
      virtualTokenReserves: monitorOutput.virtualTokenReserves,
      realSolReserves: monitorOutput.realSolReserves,
      realTokenReserves: monitorOutput.realTokenReserves
    };
    
    const tokenData: TokenData = {
      mint_address: formattedData.Ca,
      symbol: formattedData.symbol,
      name: formattedData.name,
      platform: 'pumpfun',
      creation_signature: formattedData.signature,
      creation_timestamp: new Date(formattedData.timestamp),
      creator_address: formattedData.creator,
      metadata: formattedData
    };
    
    // Save token first
    const tokenResult = await insertToken(tokenData);
    console.log(`💾 Saved Pump.fun token to database: ${tokenResult.mint_address.substring(0, 10)}...`);
    
    // Save pool if bonding curve address is available
    if (formattedData.bondingCurve) {
      try {
        const poolData = {
          pool_address: formattedData.bondingCurve,
          base_mint: formattedData.Ca,
          quote_mint: 'So11111111111111111111111111111111111111112', // SOL
          platform: 'pumpfun' as const,
          bonding_curve_address: formattedData.bondingCurve,
          virtual_sol_reserves: formattedData.virtualSolReserves,
          virtual_token_reserves: formattedData.virtualTokenReserves,
          real_sol_reserves: formattedData.realSolReserves,
          real_token_reserves: formattedData.realTokenReserves
        };
        
        const poolResult = await poolOps.insertPoolWithToken(poolData, formattedData.Ca);
        console.log(`💾 Saved Pump.fun pool to database: ${poolResult.pool_address.substring(0, 10)}...`);
      } catch (poolError) {
        console.error('Failed to save pool (may already exist):', poolError);
        // Don't fail the whole operation if pool save fails
      }
    }
    
    return tokenResult;
  } catch (error) {
    console.error('Failed to save Pump.fun token:', error);
    throw error;
  }
}

/**
 * Example integration in raydium-launchpad-monitor-new-token-mint.ts:
 * 
 * import { saveRaydiumToken } from '../database/monitor-integration';
 * 
 * // In your stream processing:
 * stream.on("data", async (data) => {
 *   // ... existing processing code ...
 *   
 *   // Save to database
 *   await saveRaydiumToken(outputData);
 * });
 */