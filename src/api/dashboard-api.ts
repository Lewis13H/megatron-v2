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

    // Query to get real price data from pools table with technical scores and holder scores
    const query = `
      WITH latest_holder_scores AS (
        SELECT DISTINCT ON (token_id)
          token_id,
          total_score,
          distribution_score,
          quality_score,
          activity_score,
          gini_coefficient,
          top_10_concentration,
          unique_holders,
          avg_wallet_age_days,
          bot_ratio,
          organic_growth_score,
          is_frozen
        FROM holder_scores
        ORDER BY token_id, is_frozen DESC, score_time DESC  -- Prefer frozen scores
      )
      SELECT 
        t.mint_address as address,
        t.symbol,
        t.name,
        COALESCE(
          t.metadata->'offChainMetadata'->>'image',
          t.metadata->>'image',
          t.metadata->>'imageUri',
          t.metadata->>'image_uri'
        ) as image_uri,
        t.created_at as token_created_at,
        t.platform,
        COALESCE(p.latest_price_usd, p.initial_price_usd, 0) as price_usd,
        COALESCE(p.latest_price, p.initial_price, 0) as price_sol,
        COALESCE(lts.total_score, 0) + COALESCE(lhs.total_score, 0) as total_score,
        COALESCE(lts.total_score, 0) as technical_score,
        COALESCE(lts.market_cap_score, 0) as market_cap_score,
        COALESCE(lts.bonding_curve_score, 0) as bonding_curve_score,
        COALESCE(lts.trading_health_score, 0) as trading_health_score,
        COALESCE(lts.selloff_response_score, 0) as selloff_response_score,
        COALESCE(lts.buy_sell_ratio, 0) as buy_sell_ratio,
        lts.is_selloff_active,
        COALESCE(lhs.total_score, 0) as holder_score,
        COALESCE(lhs.distribution_score, 0) as holder_distribution_score,
        COALESCE(lhs.quality_score, 0) as holder_quality_score,
        COALESCE(lhs.activity_score, 0) as holder_activity_score,
        lhs.gini_coefficient,
        lhs.top_10_concentration,
        lhs.unique_holders,
        lhs.avg_wallet_age_days,
        lhs.bot_ratio,
        lhs.organic_growth_score,
        0 as social_score,
        (SELECT COUNT(*) FROM transactions WHERE token_id = t.id AND block_time > NOW() - INTERVAL '24 hours') as txns_24h,
        COALESCE(lhs.unique_holders, (SELECT COUNT(DISTINCT wallet_address) FROM token_holders WHERE token_id = t.id), 0) as holder_count,
        0 as makers_24h,
        EXTRACT(epoch FROM (NOW() - t.created_at)) as age_seconds,
        (SELECT COALESCE(SUM(sol_amount), 0) FROM transactions WHERE token_id = t.id AND block_time > NOW() - INTERVAL '24 hours' AND type IN ('buy', 'sell')) as volume_24h_sol,
        0 as reserves_sol,
        0 as liquidity_usd,
        p.bonding_curve_progress as bonding_curve_progress
      FROM tokens t
      LEFT JOIN pools p ON t.id = p.token_id
      LEFT JOIN latest_technical_scores lts ON t.id = lts.token_id
      LEFT JOIN latest_holder_scores lhs ON t.id = lhs.token_id
      WHERE t.created_at > NOW() - INTERVAL '30 days'
        AND t.symbol IS NOT NULL
      ORDER BY 
        CASE 
          WHEN (COALESCE(lts.total_score, 0) + COALESCE(lhs.total_score, 0)) > 0 
          THEN (COALESCE(lts.total_score, 0) + COALESCE(lhs.total_score, 0))
          ELSE -1 
        END DESC,
        t.created_at DESC
    `;

    const result = await pool.query(query);
    
    // Format the data for frontend
    const tokens = result.rows.map((row: any, index: number) => {
      const priceSol = parseFloat(row.price_sol) || 0;
      const priceUsd = parseFloat(row.price_usd) || (priceSol * parseFloat(solPriceUsd));
      
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
          total: parseFloat(row.total_score) || 0,
          technical: parseFloat(row.technical_score) || 0,
          holder: parseFloat(row.holder_score) || 0,
          social: row.social_score,
          // Technical score breakdown
          marketCap: parseFloat(row.market_cap_score) || 0,
          bondingCurve: parseFloat(row.bonding_curve_score) || 0,
          tradingHealth: parseFloat(row.trading_health_score) || 0,
          selloffResponse: parseFloat(row.selloff_response_score) || 0,
          // Holder score breakdown
          holderDistribution: parseFloat(row.holder_distribution_score) || 0,
          holderQuality: parseFloat(row.holder_quality_score) || 0,
          holderActivity: parseFloat(row.holder_activity_score) || 0,
          // Holder metrics
          giniCoefficient: row.gini_coefficient ? parseFloat(row.gini_coefficient) : null,
          top10Concentration: row.top_10_concentration ? parseFloat(row.top_10_concentration) : null,
          uniqueHolders: row.unique_holders || null,
          avgWalletAge: row.avg_wallet_age_days ? parseFloat(row.avg_wallet_age_days) : null,
          botRatio: row.bot_ratio ? parseFloat(row.bot_ratio) : null,
          organicGrowthScore: row.organic_growth_score ? parseFloat(row.organic_growth_score) : null
        },
        buySellRatio: parseFloat(row.buy_sell_ratio) || 0,
        isSelloffActive: row.is_selloff_active || false,
        age: formatAge(row.age_seconds),
        txns24h: row.txns_24h || 0,
        holders: row.holder_count || 0,
        volume24h: {
          usd: parseFloat(row.volume_24h_sol || 0) * parseFloat(solPriceUsd),
          sol: parseFloat(row.volume_24h_sol || 0)
        },
        makers24h: row.makers_24h || 0,
        liquidity: {
          usd: 0,
          sol: 0
        },
        bondingCurveProgress: row.bonding_curve_progress !== null && row.bonding_curve_progress !== undefined ? parseFloat(row.bonding_curve_progress) : null,
        platform: row.platform || 'unknown'
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