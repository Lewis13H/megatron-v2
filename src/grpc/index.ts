import { ConnectionPool, PoolConfig, PoolStats } from './connection-pool';
import { PoolLogger } from './pool-logger';
import { MonitorAdapter } from './monitor-adapter';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Pool configuration from environment
const poolConfig: PoolConfig = {
  grpcUrl: process.env.GRPC_URL || '',
  token: process.env.X_TOKEN || '',
  maxConnections: parseInt(process.env.GRPC_POOL_MAX_CONNECTIONS || '15'),
  connectionTTL: parseInt(process.env.GRPC_POOL_CONNECTION_TTL || '300000'), // 5 minutes
  healthCheckInterval: parseInt(process.env.GRPC_POOL_HEALTH_CHECK_INTERVAL || '30000') // 30 seconds
};

// Validate configuration
if (!poolConfig.grpcUrl || !poolConfig.token) {
  console.error('[gRPC Pool] Missing required configuration: GRPC_URL and X_TOKEN must be set');
  process.exit(1);
}

// Create singleton pool instance
export const grpcPool = new ConnectionPool(poolConfig);

// Create logger instance (not started by default)
export const poolLogger = new PoolLogger(grpcPool);

// Export pool statistics function
export function getPoolStats(): PoolStats {
  return grpcPool.getStats();
}

// Export detailed report function
export function getPoolReport(): string {
  return poolLogger.getDetailedReport();
}

// Graceful shutdown handler
async function handleShutdown(): Promise<void> {
  console.log('\n[gRPC Pool] Shutting down...');
  poolLogger.stop();
  await grpcPool.shutdown();
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// Export classes for external use
export { ConnectionPool, PoolLogger, MonitorAdapter };
export type { PoolConfig, PoolStats };

console.log('[gRPC Pool] Initialized with configuration:');
console.log(`  - Max Connections: ${poolConfig.maxConnections}`);
console.log(`  - Connection TTL: ${poolConfig.connectionTTL/1000}s`);
console.log(`  - Health Check Interval: ${poolConfig.healthCheckInterval/1000}s`);
console.log(`  - Rate Limit: 60 connections per minute`);