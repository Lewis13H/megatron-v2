import { ConnectionPool } from './connection-pool';

export class PoolLogger {
  private intervalId?: NodeJS.Timeout;
  
  constructor(private pool: ConnectionPool) {}
  
  start(intervalMs: number = 10000): void {
    this.intervalId = setInterval(() => {
      this.logStats();
    }, intervalMs);
    
    console.log(`[PoolLogger] Started logging every ${intervalMs/1000} seconds`);
  }
  
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      console.log('[PoolLogger] Stopped logging');
    }
  }
  
  private logStats(): void {
    const stats = this.pool.getStats();
    
    console.log('\n========== gRPC Pool Status ==========');
    console.log(`Connections: ${stats.healthy}/${stats.total} healthy`);
    if (stats.unhealthy > 0) {
      console.log(`⚠️  Unhealthy connections: ${stats.unhealthy}`);
    }
    console.log(`Rate Limit: ${stats.rateLimitRemaining}/60 tokens available`);
    
    if (stats.monitorConnections.size > 0) {
      console.log('Monitor Connections:');
      stats.monitorConnections.forEach((count, monitor) => {
        console.log(`  - ${monitor}: ${count} connection(s)`);
      });
    } else {
      console.log('No active monitor connections');
    }
    console.log('======================================\n');
  }
  
  // One-time detailed report
  getDetailedReport(): string {
    const stats = this.pool.getStats();
    const report = [];
    
    report.push('=== gRPC Connection Pool Report ===');
    report.push(`Generated: ${new Date().toISOString()}`);
    report.push('');
    report.push('Connection Summary:');
    report.push(`  Total Connections: ${stats.total}`);
    report.push(`  Healthy: ${stats.healthy}`);
    report.push(`  Unhealthy: ${stats.unhealthy}`);
    report.push(`  Health Rate: ${stats.total > 0 ? ((stats.healthy/stats.total)*100).toFixed(1) : 0}%`);
    report.push('');
    report.push('Rate Limiting:');
    report.push(`  Available Tokens: ${stats.rateLimitRemaining}/60`);
    report.push(`  Used Tokens: ${60 - stats.rateLimitRemaining}`);
    report.push(`  Usage: ${((60 - stats.rateLimitRemaining)/60*100).toFixed(1)}%`);
    report.push('');
    
    if (stats.monitorConnections.size > 0) {
      report.push('Monitor Distribution:');
      let totalMonitorConnections = 0;
      stats.monitorConnections.forEach((count, monitor) => {
        report.push(`  ${monitor}: ${count} connection(s)`);
        totalMonitorConnections += count;
      });
      report.push(`  Total Monitors: ${stats.monitorConnections.size}`);
      report.push(`  Avg Connections/Monitor: ${(totalMonitorConnections/stats.monitorConnections.size).toFixed(2)}`);
    } else {
      report.push('No active monitors');
    }
    
    report.push('');
    report.push('=================================');
    
    return report.join('\n');
  }
}