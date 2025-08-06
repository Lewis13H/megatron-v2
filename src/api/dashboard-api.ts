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

// Get top tokens with technical scores
router.get('/tokens', async (req, res) => {
  try {
    const pool = getDbPool();
    
    // Get limit from query params, default to 500, max 2000
    const requestedLimit = parseInt(req.query.limit as string) || 500;
    const limit = Math.min(requestedLimit, 2000);
    
    // First get the latest SOL price
    const solPriceResult = await pool.query(`
      SELECT price_usd 
      FROM sol_usd_prices 
      ORDER BY price_time DESC 
      LIMIT 1
    `);
    const solPriceUsd = solPriceResult.rows[0]?.price_usd || 165; // More realistic default

    // Query using the scoring function
    const query = `
      WITH active_tokens AS (
        -- Get tokens with recent activity
        SELECT DISTINCT 
          t.id as token_id,
          t.mint_address,
          t.symbol,
          t.name,
          t.created_at,
          t.platform,
          t.is_graduated,
          COALESCE(
            t.metadata->'offChainMetadata'->>'image',
            t.metadata->>'image',
            t.metadata->>'imageUri',
            t.metadata->>'image_uri'
          ) as image_uri,
          p.id as pool_id,
          p.pool_address,
          p.latest_price_usd,
          p.latest_price,
          p.initial_price_usd,
          p.initial_price,
          p.bonding_curve_progress
        FROM tokens t
        JOIN pools p ON t.id = p.token_id
        WHERE t.created_at > NOW() - INTERVAL '30 days'
          AND t.symbol IS NOT NULL
          AND p.status = 'active'
          AND EXISTS (
            SELECT 1 FROM transactions tx
            WHERE tx.pool_id = p.id
            AND tx.block_time > NOW() - INTERVAL '24 hours'
          )
        ORDER BY p.latest_price_usd DESC NULLS LAST
        LIMIT $1
      ),
      tokens_with_scores AS (
        SELECT 
          at.*,
          -- Calculate technical scores in real-time
          ts.total_score as technical_score,
          ts.market_cap_score,
          ts.bonding_curve_score,
          ts.trading_health_score,
          ts.selloff_response_score,
          ts.market_cap_usd,
          ts.buy_sell_ratio,
          ts.is_selloff_active
        FROM active_tokens at
        CROSS JOIN LATERAL calculate_technical_score(at.token_id, at.pool_id) ts
      ),
      latest_holder_scores AS (
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
        ORDER BY token_id, is_frozen DESC, score_time DESC
      )
      SELECT 
        tws.mint_address as address,
        tws.symbol,
        tws.name,
        tws.image_uri,
        tws.created_at as token_created_at,
        tws.platform,
        COALESCE(tws.latest_price_usd, tws.initial_price_usd, 0) as price_usd,
        COALESCE(tws.latest_price, tws.initial_price, 0) as price_sol,
        -- Scoring
        COALESCE(tws.technical_score, 0) + COALESCE(lhs.total_score, 0) as total_score,
        COALESCE(tws.technical_score, 0) as technical_score,
        COALESCE(tws.market_cap_score, 0) as market_cap_score,
        COALESCE(tws.bonding_curve_score, 0) as bonding_curve_score,
        COALESCE(tws.trading_health_score, 0) as trading_health_score,
        COALESCE(tws.selloff_response_score, 0) as selloff_response_score,
        COALESCE(tws.buy_sell_ratio, 0) as buy_sell_ratio,
        tws.is_selloff_active,
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
        (SELECT COUNT(*) FROM transactions WHERE token_id = tws.token_id AND block_time > NOW() - INTERVAL '24 hours') as txns_24h,
        COALESCE(lhs.unique_holders, 0) as holder_count,
        0 as makers_24h,
        EXTRACT(epoch FROM (NOW() - tws.created_at)) as age_seconds,
        (SELECT COALESCE(SUM(sol_amount), 0) FROM transactions WHERE token_id = tws.token_id AND block_time > NOW() - INTERVAL '24 hours' AND type IN ('buy', 'sell')) as volume_24h_sol,
        tws.bonding_curve_progress,
        tws.is_graduated,
        tws.market_cap_usd
      FROM tokens_with_scores tws
      LEFT JOIN latest_holder_scores lhs ON tws.token_id = lhs.token_id
      ORDER BY 
        COALESCE(tws.technical_score, 0) + COALESCE(lhs.total_score, 0) DESC,
        tws.created_at DESC
    `;

    const result = await pool.query(query, [limit]);
    
    // Format the data for frontend
    const tokens = result.rows.map((row: any, index: number) => {
      const priceSol = parseFloat(row.price_sol) || 0;
      const priceUsd = parseFloat(row.price_usd) || (priceSol * parseFloat(solPriceUsd));
      const marketCapUsd = parseFloat(row.market_cap_usd) || (priceUsd * 1_000_000_000);
      
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
          usd: marketCapUsd,
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
        bondingCurveProgress: row.bonding_curve_progress !== null ? parseFloat(row.bonding_curve_progress) : null,
        isGraduated: row.is_graduated || false,
        platform: row.platform
      };
    });

    res.json({
      success: true,
      tokens: tokens,
      timestamp: new Date(),
      solPrice: parseFloat(solPriceUsd)
    });

  } catch (error) {
    console.error('Error fetching tokens:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get SOL price
router.get('/sol-price', async (req, res) => {
  try {
    const pool = getDbPool();
    const result = await pool.query(`
      SELECT price_usd, price_time 
      FROM sol_usd_prices 
      ORDER BY price_time DESC 
      LIMIT 1
    `);
    
    if (result.rows.length > 0) {
      res.json({
        success: true,
        price: parseFloat(result.rows[0].price_usd),
        timestamp: result.rows[0].price_time
      });
    } else {
      // If no price in database, return a default
      res.json({
        success: true,
        price: 165, // More realistic default
        timestamp: new Date(),
        source: 'default'
      });
    }
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get market sentiment summary
router.get('/sentiment', async (req, res) => {
  try {
    const pool = getDbPool();
    const result = await pool.query(`
      WITH active_scores AS (
        SELECT 
          t.id as token_id,
          p.id as pool_id,
          ts.total_score,
          ts.is_selloff_active
        FROM tokens t
        JOIN pools p ON t.id = p.token_id
        CROSS JOIN LATERAL calculate_technical_score(t.id, p.id) ts
        WHERE p.status = 'active'
        AND EXISTS (
          SELECT 1 FROM transactions tx
          WHERE tx.pool_id = p.id
          AND tx.block_time > NOW() - INTERVAL '1 hour'
        )
        LIMIT 100
      )
      SELECT 
        COUNT(CASE WHEN total_score > 200 THEN 1 END) as bullish,
        COUNT(CASE WHEN total_score < 100 THEN 1 END) as bearish,
        COUNT(CASE WHEN total_score BETWEEN 100 AND 200 THEN 1 END) as neutral,
        COUNT(CASE WHEN is_selloff_active THEN 1 END) as active_selloffs,
        AVG(total_score) as avg_score,
        MAX(total_score) as max_score,
        MIN(total_score) as min_score
      FROM active_scores
    `);
    
    res.json({
      success: true,
      sentiment: result.rows[0],
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Error fetching sentiment:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Helper function to format age
function formatAge(seconds: number): string {
  if (!seconds) return 'New';
  
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m`;
}

export default router;