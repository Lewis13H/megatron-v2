import { getDbPool } from './connection';
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

const pool = getDbPool();
const poolOps = new PoolOperations();

// Helper function to get current SOL price
async function getCurrentSolPrice(): Promise<number | null> {
  try {
    const result = await pool.query(`
      SELECT price_usd 
      FROM sol_usd_prices 
      ORDER BY price_time DESC 
      LIMIT 1
    `);
    
    if (result.rows.length > 0) {
      return parseFloat(result.rows[0].price_usd);
    }
    
    console.warn('No SOL/USD price found in database');
    return null;
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    return null;
  }
}

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
      initialLiquidity: monitorOutput.initialLiquidity || null,
      creator: monitorOutput.creator || 'unknown' // You may need to extract this from transaction
    };
    
    const tokenData: TokenData = {
      mint_address: formattedData.baseTokenMint,
      symbol: monitorOutput.tokenMetadata?.symbol || monitorOutput.tokenMetadata?.onChainSymbol,
      name: monitorOutput.tokenMetadata?.name || monitorOutput.tokenMetadata?.onChainName,
      platform: 'raydium_launchpad',
      creation_signature: formattedData.signature,
      creation_timestamp: new Date(formattedData.timestamp),
      creator_address: formattedData.creator || 'unknown',
      metadata: {
        pool_state: formattedData.poolState,
        quote_token_mint: formattedData.quoteTokenMint,
        initial_price: formattedData.initialPrice,
        initial_liquidity: formattedData.initialLiquidity,
        ...(monitorOutput.tokenMetadata || {})
      }
    };
    
    // Save token first
    const tokenResult = await insertToken(tokenData);
    console.log(`💾 Saved Raydium token to database: ${tokenResult.mint_address.substring(0, 10)}...`);
    
    // Now save the pool
    try {
      // Calculate USD values
      let initialPriceUsd: string | undefined;
      
      if (formattedData.initialPrice) {
        const solPrice = await getCurrentSolPrice();
        if (solPrice) {
          const priceInUsd = parseFloat(formattedData.initialPrice) * solPrice;
          initialPriceUsd = priceInUsd.toFixed(20).replace(/0+$/, '');
          console.log(`   USD Price: $${priceInUsd.toFixed(9)}`);
        }
      }
      
      // Prepare pool data
      const poolData = {
        pool_address: formattedData.poolState,
        base_mint: formattedData.baseTokenMint,
        quote_mint: formattedData.quoteTokenMint === 'SOL' ? 'So11111111111111111111111111111111111111112' : formattedData.quoteTokenMint,
        platform: 'raydium_launchpad' as const,
        initial_price: formattedData.initialPrice,
        initial_price_usd: initialPriceUsd,
        latest_price: formattedData.initialPrice,
        latest_price_usd: initialPriceUsd,
        initial_quote_liquidity: formattedData.initialLiquidity ? String(formattedData.initialLiquidity) : undefined,
        bonding_curve_progress: 0 // Raydium Launchpad tokens start at 0% progress
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
      bondingCurve: monitorOutput.bondingCurve || monitorOutput.bonding_curve || monitorOutput.metadata?.bondingCurve,
      virtualSolReserves: monitorOutput.virtualSolReserves,
      virtualTokenReserves: monitorOutput.virtualTokenReserves,
      realSolReserves: monitorOutput.realSolReserves,
      realTokenReserves: monitorOutput.realTokenReserves,
      // Extract all the additional fields from metadata if present
      uri: monitorOutput.uri || monitorOutput.metadata?.uri,
      mintAuthority: monitorOutput.mintAuthority || monitorOutput.metadata?.mintAuthority,
      associatedBondingCurve: monitorOutput.associatedBondingCurve || monitorOutput.metadata?.associatedBondingCurve,
      global: monitorOutput.global || monitorOutput.metadata?.global,
      mplTokenMetadata: monitorOutput.mplTokenMetadata || monitorOutput.metadata?.mplTokenMetadata,
      metadataAccount: monitorOutput.metadata?.metadataAccount || monitorOutput.metadata?.metadata,
      slot: monitorOutput.slot || monitorOutput.metadata?.slot,
      offChainMetadata: monitorOutput.metadata?.offChainMetadata
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
        // Calculate initial price and bonding curve progress
        let initialPrice: string | undefined;
        let initialPriceUsd: string | undefined;
        let bondingCurveProgress: number | undefined;
        let marketCapUsd: number | undefined;
        
        if (formattedData.virtualSolReserves && formattedData.virtualTokenReserves) {
          // Calculate price: virtualSolReserves / virtualTokenReserves
          const sol = Number(formattedData.virtualSolReserves) / 1_000_000_000; // convert lamports to SOL
          const tokens = Number(formattedData.virtualTokenReserves) / Math.pow(10, 6);
          const priceInSol = sol / tokens;
          initialPrice = priceInSol.toFixed(20).replace(/0+$/, '');
          
          // Get current SOL price for USD calculations
          const solPrice = await getCurrentSolPrice();
          if (solPrice) {
            const priceInUsd = priceInSol * solPrice;
            initialPriceUsd = priceInUsd.toFixed(20).replace(/0+$/, '');
            
            // Calculate market cap (1 billion token supply)
            marketCapUsd = priceInUsd * 1_000_000_000;
            console.log(`   USD Price: $${priceInUsd.toFixed(9)}, Market Cap: $${marketCapUsd.toFixed(2)}`);
          }
          
          // Calculate bonding curve progress
          const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000 * Math.pow(10, 6);
          const TOTAL_SELLABLE_TOKENS = 793_100_000 * Math.pow(10, 6);
          const tokensSold = INITIAL_VIRTUAL_TOKEN_RESERVES - Number(formattedData.virtualTokenReserves);
          const progress = (tokensSold / TOTAL_SELLABLE_TOKENS) * 100;
          bondingCurveProgress = Math.min(Math.max(progress, 0), 100);
        }
        
        const poolData = {
          pool_address: formattedData.bondingCurve,
          base_mint: formattedData.Ca,
          quote_mint: 'So11111111111111111111111111111111111111112', // SOL
          platform: 'pumpfun' as const,
          bonding_curve_address: formattedData.bondingCurve,
          virtual_sol_reserves: formattedData.virtualSolReserves,
          virtual_token_reserves: formattedData.virtualTokenReserves,
          real_sol_reserves: formattedData.realSolReserves,
          real_token_reserves: formattedData.realTokenReserves,
          latest_price: initialPrice,
          latest_price_usd: initialPriceUsd,
          bonding_curve_progress: bondingCurveProgress
        };
        
        const poolResult = await poolOps.insertPoolWithToken(poolData, formattedData.Ca);
        console.log(`💾 Saved Pump.fun pool to database: ${poolResult.pool_address.substring(0, 10)}...`);
        console.log(`   Initial price: ${initialPrice || 'N/A'}, Progress: ${bondingCurveProgress !== undefined ? bondingCurveProgress.toFixed(2) + '%' : 'N/A'}`);
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