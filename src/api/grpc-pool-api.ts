import { Router, Request, Response } from 'express';
import { getPoolStats, getPoolReport } from '../grpc';

const router = Router();

// Get current pool statistics
router.get('/api/grpc-pool/stats', (req: Request, res: Response) => {
  try {
    const stats = getPoolStats();
    
    res.json({
      success: true,
      data: {
        connections: {
          total: stats.total,
          healthy: stats.healthy,
          unhealthy: stats.unhealthy,
          healthRate: stats.total > 0 ? ((stats.healthy / stats.total) * 100).toFixed(1) : 0
        },
        rateLimit: {
          available: stats.rateLimitRemaining,
          used: 60 - stats.rateLimitRemaining,
          maxPerMinute: 60,
          usagePercent: ((60 - stats.rateLimitRemaining) / 60 * 100).toFixed(1)
        },
        monitors: Object.fromEntries(stats.monitorConnections)
      },
      timestamp: new Date()
    });
  } catch (error) {
    console.error('[API] Error getting pool stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get pool statistics'
    });
  }
});

// Get detailed pool report
router.get('/api/grpc-pool/report', (req: Request, res: Response) => {
  try {
    const report = getPoolReport();
    
    res.json({
      success: true,
      report: report,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('[API] Error getting pool report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get pool report'
    });
  }
});

// Health check endpoint
router.get('/api/grpc-pool/health', (req: Request, res: Response) => {
  try {
    const stats = getPoolStats();
    
    // Health criteria:
    // - At least one healthy connection OR pool is empty (just started)
    // - Rate limit not exhausted (at least 10 tokens remaining)
    const isHealthy = (stats.healthy > 0 || stats.total === 0) && stats.rateLimitRemaining > 10;
    
    const healthStatus = {
      status: isHealthy ? 'healthy' : 'degraded',
      checks: {
        connections: stats.healthy > 0 || stats.total === 0,
        rateLimit: stats.rateLimitRemaining > 10
      },
      details: {
        healthyConnections: stats.healthy,
        totalConnections: stats.total,
        rateLimitRemaining: stats.rateLimitRemaining
      }
    };
    
    res.status(isHealthy ? 200 : 503).json(healthStatus);
  } catch (error) {
    console.error('[API] Error checking pool health:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: 'Failed to check pool health'
    });
  }
});

export default router;