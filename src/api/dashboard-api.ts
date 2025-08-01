import express from 'express';
import { Router } from 'express';
import { getDbPool } from '../database/connection';

const router = Router();

// Debug endpoint
router.get('/debug', async (req, res) => {
  try {
    const pool = getDbPool();
    const result = await pool.query('SELECT COUNT(*) as count FROM tokens');
    res.json({ 
      success: true, 
      tokenCount: result.rows[0].count,
      timestamp: new Date() 
    });
  } catch (error) {
    res.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// Simple test endpoint
router.get('/test', async (req, res) => {
  res.json({ 
    message: 'API is working',
    timestamp: new Date()
  });
});

// Get top tokens with scores
router.get('/tokens', async (req, res) => {
  try {
    // First get the latest SOL price
    const pool = getDbPool();
    const solPriceResult = await pool.query(`
      SELECT price_usd 
      FROM sol_usd_prices 
      ORDER BY price_time DESC 
      LIMIT 1
    `);
    const solPriceUsd = solPriceResult.rows[0]?.price_usd || 200; // Default to $200 if no price

    // Query to get real price data from pools table
    const query = `
      SELECT 
        t.mint_address as address,
        t.symbol,
        t.name,
        t.metadata->>'image' as image_uri,
        t.created_at as token_created_at,
        COALESCE(p.latest_price_usd, p.initial_price_usd, 0) as price_usd,
        COALESCE(p.latest_price, p.initial_price, 0) as price_sol,
        0 as total_score,
        0 as technical_score,
        0 as holder_score,
        0 as social_score,
        0 as txns_24h,
        0 as makers_24h,
        EXTRACT(epoch FROM (NOW() - t.created_at)) as age_seconds,
        0 as volume_24h_usd,
        0 as reserves_sol,
        0 as liquidity_usd,
        p.bonding_curve_progress as bonding_curve_progress
      FROM tokens t
      LEFT JOIN pools p ON t.id = p.token_id
      WHERE t.created_at > NOW() - INTERVAL '30 days'
        AND t.symbol IS NOT NULL
      ORDER BY t.created_at DESC
      LIMIT 50
    `;

    const result = await pool.query(query);
    
    // Format the data for frontend
    const tokens = result.rows.map((row: any, index: number) => {
      const priceSol = parseFloat(row.price_sol) || 0;
      const priceUsd = priceSol * parseFloat(solPriceUsd);
      
      return {
        rank: index + 1,
        address: row.address,
        symbol: row.symbol,
        name: row.name,
        image: row.image_uri || null,
        price: {
          usd: priceUsd,
          sol: priceSol
        },
        marketCap: {
          usd: priceUsd * 1_000_000_000, // 1B supply
          sol: priceSol * 1_000_000_000
        },
        scores: {
          total: row.total_score,
          technical: row.technical_score,
          holder: row.holder_score,
          social: row.social_score
        },
        age: formatAge(row.age_seconds),
        txns24h: row.txns_24h || 0,
        volume24h: {
          usd: 0,
          sol: 0
        },
        makers24h: row.makers_24h || 0,
        liquidity: {
          usd: 0,
          sol: 0
        },
        platform: row.bonding_curve_progress !== null ? 'pumpfun' : 'raydium'
      };
    });

    res.json({ tokens, timestamp: new Date() });
  } catch (error) {
    console.error('Error fetching tokens:', error);
    console.error('Error details:', error instanceof Error ? error.stack : 'Unknown error');
    res.status(500).json({ 
      error: 'Failed to fetch tokens',
      details: error instanceof Error ? error.message : 'Unknown error',
      stack: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.stack : undefined) : undefined
    });
  }
});

// Get SOL price
router.get('/sol-price', async (req, res) => {
  try {
    const query = `
      SELECT price_usd, created_at
      FROM sol_usd_prices
      ORDER BY created_at DESC
      LIMIT 1
    `;
    
    const pool = getDbPool();
    const result = await pool.query(query);
    
    if (result.rows.length > 0) {
      const row = result.rows[0];
      res.json({
        price: row.price_usd,
        updatedAt: row.created_at,
        secondsAgo: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000)
      });
    } else {
      res.json({ price: 200.00, updatedAt: new Date(), secondsAgo: 0 });
    }
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    res.status(500).json({ error: 'Failed to fetch SOL price' });
  }
});

// Helper function to format age
function formatAge(seconds: number | string | null): string {
  if (!seconds) return '0s';
  const sec = typeof seconds === 'string' ? parseFloat(seconds) : seconds;
  if (isNaN(sec)) return '0s';
  
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 2592000) return `${Math.floor(sec / 86400)}d`;
  return `${Math.floor(sec / 2592000)}mo`;
}

export default router;