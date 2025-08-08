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
    
    // Get pagination params
    const page = parseInt(req.query.page as string) || 1;
    const requestedLimit = parseInt(req.query.limit as string) || 50;
    const limit = Math.min(requestedLimit, 100); // Max 100 per page
    const offset = (page - 1) * limit;
    
    // Get sorting params
    const sortBy = (req.query.sortBy as string) || 'created_at';
    const sortDirection = (req.query.sortDirection as string)?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    
    console.log(`Fetching page ${page} with ${limit} tokens (offset: ${offset}), sorted by ${sortBy} ${sortDirection}...`);
    
    // First get the latest SOL price
    const solPriceResult = await pool.query(`
      SELECT price_usd 
      FROM sol_usd_prices 
      ORDER BY price_time DESC 
      LIMIT 1
    `);
    const solPriceUsd = solPriceResult.rows[0]?.price_usd || 165; // More realistic default

    // Map frontend column names to database columns
    const sortColumnMap: {[key: string]: string} = {
      'created_at': 'token_created_at',
      'symbol': 'symbol',
      'name': 'name',
      'price': 'price_usd',
      'marketCap': 'market_cap_usd',
      'progress': 'bonding_curve_progress',
      'total': 'total_score',
      'technical': 'technical_score',
      'holder': 'holder_score',
      'social': 'social_score',
      'age': 'age_seconds',
      'txns': 'txns_24h',
      'holders': 'holder_count',
      'volume': 'volume_24h_sol',
      'makers': 'makers_24h',
      'liquidity': 'price_usd'  // Using price as proxy for liquidity for now
    };
    
    const orderByColumn = sortColumnMap[sortBy] || 'token_created_at';
    
    // Query with proper total score calculation using aggregate scores when available
    const query = `
      WITH token_data AS (
        SELECT 
          t.id as token_id,
          p.id as pool_id,
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
          -- Use aggregate scores if available, otherwise calculate
          COALESCE(
            ag.total_score, 
            COALESCE(ts.total_score, 0) + COALESCE(hs.total_score, 0) + COALESCE(ss.social_score, 0)
          ) as total_score,
          COALESCE(ag.technical_score, ts.total_score, 0) as technical_score,
          ts.market_cap_score,
          ts.bonding_curve_score,
          ts.trading_health_score,
          ts.selloff_response_score,
          ts.buy_sell_ratio,
          ts.is_selloff_active,
          COALESCE(ag.holder_score, hs.total_score, 0) as holder_score,
          COALESCE(hs.distribution_score, 0) as holder_distribution_score,
          COALESCE(hs.quality_score, 0) as holder_quality_score,
          COALESCE(hs.activity_score, 0) as holder_activity_score,
          COALESCE(ag.gini_coefficient, hs.gini_coefficient) as gini_coefficient,
          COALESCE(hsnap.top_10_percent, 0) as top_10_concentration,
          COALESCE(ag.unique_holders, hs.unique_holders, 0) as unique_holders,
          COALESCE(hsnap.avg_wallet_age_days, 0) as avg_wallet_age_days,
          COALESCE(ag.bot_ratio, hs.bot_ratio, 0) as bot_ratio,
          COALESCE(hsnap.organic_growth_score, 0) as organic_growth_score,
          COALESCE(ag.social_score, ss.social_score, 0) as social_score,
          (SELECT COUNT(*) FROM transactions WHERE token_id = t.id AND block_time > NOW() - INTERVAL '24 hours') as txns_24h,
          COALESCE(hs.unique_holders, 0) as holder_count,
          0 as makers_24h,
          EXTRACT(epoch FROM (NOW() - t.created_at)) as age_seconds,
          (SELECT COALESCE(SUM(sol_amount), 0) FROM transactions WHERE token_id = t.id AND block_time > NOW() - INTERVAL '24 hours' AND type IN ('buy', 'sell')) as volume_24h_sol,
          p.bonding_curve_progress,
          t.is_graduated,
          COALESCE(p.latest_price_usd, p.initial_price_usd, 0) * 1000000000 as market_cap_usd
        FROM tokens t
        JOIN pools p ON t.id = p.token_id
        LEFT JOIN LATERAL (
          SELECT * FROM calculate_technical_score(t.id, p.id)
        ) ts ON true
        LEFT JOIN LATERAL (
          SELECT * FROM holder_scores_v2
          WHERE token_id = t.id
          ORDER BY score_time DESC
          LIMIT 1
        ) hs ON true
        LEFT JOIN LATERAL (
          SELECT * FROM holder_snapshots_v2
          WHERE token_id = t.id
          ORDER BY snapshot_time DESC
          LIMIT 1
        ) hsnap ON true
        LEFT JOIN LATERAL (
          -- Get aggregate scores if available
          SELECT * FROM latest_aggregate_scores
          WHERE token_id = t.id
        ) ag ON true
        LEFT JOIN LATERAL (
          -- Placeholder for social scores (not implemented yet)
          SELECT 0 as social_score
        ) ss ON true
        WHERE t.symbol IS NOT NULL
          AND p.status = 'active'
      )
      SELECT * FROM token_data
      ORDER BY ${orderByColumn} ${sortDirection} NULLS LAST
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, [limit, offset]);
    
    // Debug logging for score verification
    if (result.rows.length > 0) {
      const firstRow = result.rows[0];
      console.log(`Debug - First token (${firstRow.symbol}): total_score=${firstRow.total_score}, technical=${firstRow.technical_score}, holder=${firstRow.holder_score}`);
    }
    
    // Get total count for pagination
    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM tokens t
      JOIN pools p ON t.id = p.token_id
      WHERE t.symbol IS NOT NULL
        AND p.status = 'active'
    `);
    const totalTokens = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalTokens / limit);
    
    // Format the data for frontend
    const tokens = result.rows.map((row: any, index: number) => {
      const priceSol = parseFloat(row.price_sol) || 0;
      const priceUsd = parseFloat(row.price_usd) || (priceSol * parseFloat(solPriceUsd));
      const marketCapUsd = parseFloat(row.market_cap_usd) || (priceUsd * 1_000_000_000);
      
      // Calculate total score properly (in case DB query didn't)
      const technicalScore = parseFloat(row.technical_score) || 0;
      const holderScore = parseFloat(row.holder_score) || 0;
      const socialScore = parseFloat(row.social_score) || 0;
      const totalScore = parseFloat(row.total_score) || (technicalScore + holderScore + socialScore);
      
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
          total: totalScore,  // Properly calculated total
          technical: technicalScore,
          holder: holderScore,
          social: socialScore,
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
      pagination: {
        page: page,
        limit: limit,
        total: totalTokens,
        totalPages: totalPages
      },
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

// Get recent transactions
router.get('/transactions', async (req, res) => {
  try {
    const pool = getDbPool();
    const limit = parseInt(req.query.limit as string) || 100;
    const tokenId = req.query.tokenId as string;
    
    let query = `
      SELECT 
        tx.signature,
        tx.type,
        tx.block_time,
        tx.user_address,
        tx.sol_amount,
        tx.token_amount,
        tx.price_per_token,
        t.symbol,
        t.name,
        t.mint_address,
        p.bonding_curve_progress
      FROM transactions tx
      JOIN tokens t ON tx.token_id = t.id
      JOIN pools p ON tx.pool_id = p.id
    `;
    
    const params: any[] = [];
    if (tokenId) {
      query += ' WHERE tx.token_id = $1';
      params.push(tokenId);
    }
    
    query += ` ORDER BY tx.block_time DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      transactions: result.rows.map(tx => ({
        signature: tx.signature,
        type: tx.type,
        blockTime: tx.block_time,
        userAddress: tx.user_address,
        solAmount: parseFloat(tx.sol_amount),
        tokenAmount: parseFloat(tx.token_amount),
        pricePerToken: parseFloat(tx.price_per_token),
        token: {
          symbol: tx.symbol,
          name: tx.name,
          mintAddress: tx.mint_address
        },
        bondingCurveProgress: parseFloat(tx.bonding_curve_progress)
      })),
      count: result.rows.length,
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Error fetching transactions:', error);
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

// Search for a token by mint address
router.get('/search/:mintAddress', async (req, res) => {
  try {
    const pool = getDbPool();
    const mintAddress = req.params.mintAddress;
    
    // First get the latest SOL price
    const solPriceResult = await pool.query(`
      SELECT price_usd 
      FROM sol_usd_prices 
      ORDER BY price_time DESC 
      LIMIT 1
    `);
    const solPriceUsd = solPriceResult.rows[0]?.price_usd || 165;

    // Query for the specific token
    const query = `
      WITH token_data AS (
        SELECT 
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
        LEFT JOIN pools p ON t.id = p.token_id
        WHERE LOWER(t.mint_address) = LOWER($1)
        LIMIT 1
      ),
      token_with_scores AS (
        SELECT 
          td.*,
          -- Calculate technical scores if pool exists
          CASE 
            WHEN td.pool_id IS NOT NULL THEN 
              (SELECT total_score FROM calculate_technical_score(td.token_id, td.pool_id))
            ELSE 0
          END as technical_score,
          CASE 
            WHEN td.pool_id IS NOT NULL THEN 
              (SELECT market_cap_score FROM calculate_technical_score(td.token_id, td.pool_id))
            ELSE 0
          END as market_cap_score,
          CASE 
            WHEN td.pool_id IS NOT NULL THEN 
              (SELECT bonding_curve_score FROM calculate_technical_score(td.token_id, td.pool_id))
            ELSE 0
          END as bonding_curve_score,
          CASE 
            WHEN td.pool_id IS NOT NULL THEN 
              (SELECT trading_health_score FROM calculate_technical_score(td.token_id, td.pool_id))
            ELSE 0
          END as trading_health_score,
          CASE 
            WHEN td.pool_id IS NOT NULL THEN 
              (SELECT selloff_response_score FROM calculate_technical_score(td.token_id, td.pool_id))
            ELSE 0
          END as selloff_response_score,
          CASE 
            WHEN td.pool_id IS NOT NULL THEN 
              (SELECT market_cap_usd FROM calculate_technical_score(td.token_id, td.pool_id))
            ELSE 0
          END as market_cap_usd,
          CASE 
            WHEN td.pool_id IS NOT NULL THEN 
              (SELECT buy_sell_ratio FROM calculate_technical_score(td.token_id, td.pool_id))
            ELSE 0
          END as buy_sell_ratio,
          CASE 
            WHEN td.pool_id IS NOT NULL THEN 
              (SELECT is_selloff_active FROM calculate_technical_score(td.token_id, td.pool_id))
            ELSE false
          END as is_selloff_active
        FROM token_data td
      ),
      latest_holder_scores AS (
        SELECT DISTINCT ON (token_id)
          token_id,
          total_score,
          distribution_score,
          quality_score,
          activity_score,
          gini_coefficient,
          bot_ratio,
          unique_holders,
          overall_risk,
          smart_money_ratio,
          is_frozen
        FROM holder_scores_v2
        WHERE token_id = (SELECT token_id FROM token_data)
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
        lhs.unique_holders,
        lhs.bot_ratio,
        0 as social_score,
        (SELECT COUNT(*) FROM transactions WHERE token_id = tws.token_id AND block_time > NOW() - INTERVAL '24 hours') as txns_24h,
        COALESCE(lhs.unique_holders, 0) as holder_count,
        EXTRACT(epoch FROM (NOW() - tws.created_at)) as age_seconds,
        (SELECT COALESCE(SUM(sol_amount), 0) FROM transactions WHERE token_id = tws.token_id AND block_time > NOW() - INTERVAL '24 hours' AND type IN ('buy', 'sell')) as volume_24h_sol,
        tws.bonding_curve_progress,
        tws.is_graduated,
        tws.market_cap_usd
      FROM token_with_scores tws
      LEFT JOIN latest_holder_scores lhs ON tws.token_id = lhs.token_id
    `;

    const result = await pool.query(query, [mintAddress]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Token not found'
      });
    }

    // Format the data for frontend
    const row = result.rows[0];
    const priceSol = parseFloat(row.price_sol) || 0;
    const priceUsd = parseFloat(row.price_usd) || (priceSol * parseFloat(solPriceUsd));
    const marketCapUsd = parseFloat(row.market_cap_usd) || (priceUsd * 1_000_000_000);
    
    const token = {
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
        marketCap: parseFloat(row.market_cap_score) || 0,
        bondingCurve: parseFloat(row.bonding_curve_score) || 0,
        tradingHealth: parseFloat(row.trading_health_score) || 0,
        selloffResponse: parseFloat(row.selloff_response_score) || 0,
        holderDistribution: parseFloat(row.holder_distribution_score) || 0,
        holderQuality: parseFloat(row.holder_quality_score) || 0,
        holderActivity: parseFloat(row.holder_activity_score) || 0,
        giniCoefficient: row.gini_coefficient ? parseFloat(row.gini_coefficient) : null,
        uniqueHolders: row.unique_holders || null,
        botRatio: row.bot_ratio ? parseFloat(row.bot_ratio) : null
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
      bondingCurveProgress: row.bonding_curve_progress !== null ? parseFloat(row.bonding_curve_progress) : null,
      isGraduated: row.is_graduated || false,
      platform: row.platform
    };

    res.json({
      success: true,
      token: token,
      timestamp: new Date(),
      solPrice: parseFloat(solPriceUsd)
    });

  } catch (error) {
    console.error('Error searching for token:', error);
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