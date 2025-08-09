import { grpcPool, poolLogger, getPoolStats, getPoolReport } from '../grpc';
import { MonitorAdapter } from '../grpc/monitor-adapter';
import Client from '@triton-one/yellowstone-grpc';

// Mock monitor for testing
class TestMonitor extends MonitorAdapter {
  private streamActive: boolean = false;
  
  constructor(monitorId: string) {
    super(grpcPool, monitorId);
  }
  
  async start(): Promise<void> {
    console.log(`[${this.monitorId}] Starting test monitor`);
    
    try {
      const client = await this.getClient();
      console.log(`[${this.monitorId}] Got client, simulating stream activity`);
      
      this.streamActive = true;
      
      // Simulate stream activity
      const interval = setInterval(() => {
        if (!this.streamActive) {
          clearInterval(interval);
          return;
        }
        console.log(`[${this.monitorId}] Processing simulated data...`);
      }, 5000);
      
    } catch (error) {
      this.handleConnectionError(error as Error);
    }
  }
  
  async stop(): Promise<void> {
    this.streamActive = false;
    await super.stop();
  }
}

async function testConnectionPool() {
  console.log('========================================');
  console.log('gRPC Connection Pool Test Script');
  console.log('========================================\n');
  
  // Start the pool logger
  poolLogger.start(5000); // Log every 5 seconds
  
  // Test 1: Create multiple monitors
  console.log('Test 1: Creating multiple test monitors...\n');
  const monitors: TestMonitor[] = [];
  
  for (let i = 1; i <= 5; i++) {
    const monitor = new TestMonitor(`test-monitor-${i}`);
    monitors.push(monitor);
    
    try {
      await monitor.start();
      console.log(`✓ Monitor ${i} started successfully`);
    } catch (error) {
      console.error(`✗ Monitor ${i} failed to start:`, error);
    }
    
    // Small delay between monitor starts
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Wait a bit to see some activity
  console.log('\nLetting monitors run for 15 seconds...\n');
  await new Promise(resolve => setTimeout(resolve, 15000));
  
  // Test 2: Check pool statistics
  console.log('\nTest 2: Checking pool statistics...\n');
  const stats = getPoolStats();
  console.log('Current pool stats:');
  console.log(`  - Total connections: ${stats.total}`);
  console.log(`  - Healthy connections: ${stats.healthy}`);
  console.log(`  - Rate limit remaining: ${stats.rateLimitRemaining}/60`);
  
  // Test 3: Generate detailed report
  console.log('\nTest 3: Generating detailed report...\n');
  const report = getPoolReport();
  console.log(report);
  
  // Test 4: Test connection reuse
  console.log('\nTest 4: Testing connection reuse...');
  console.log('Stopping monitor 1 and starting a new monitor...\n');
  
  await monitors[0].stop();
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const newMonitor = new TestMonitor('test-monitor-new');
  await newMonitor.start();
  console.log('✓ New monitor started, should reuse connection');
  
  // Wait a bit more
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Test 5: Test rate limiting
  console.log('\nTest 5: Testing rate limit protection...');
  console.log('Attempting to create many connections rapidly...\n');
  
  const rapidMonitors: TestMonitor[] = [];
  let rateLimitHit = false;
  
  for (let i = 1; i <= 20; i++) {
    const monitor = new TestMonitor(`rapid-monitor-${i}`);
    try {
      await monitor.start();
      rapidMonitors.push(monitor);
      console.log(`✓ Rapid monitor ${i} started`);
    } catch (error: any) {
      if (error.message.includes('Rate limit')) {
        if (!rateLimitHit) {
          console.log(`✓ Rate limit protection triggered at monitor ${i}`);
          rateLimitHit = true;
        }
      } else {
        console.error(`✗ Unexpected error for rapid monitor ${i}:`, error.message);
      }
    }
  }
  
  // Final stats
  console.log('\n========================================');
  console.log('Final Pool Statistics');
  console.log('========================================\n');
  console.log(getPoolReport());
  
  // Cleanup
  console.log('\nCleaning up...');
  poolLogger.stop();
  
  // Stop all monitors
  for (const monitor of [...monitors, newMonitor, ...rapidMonitors]) {
    await monitor.stop();
  }
  
  await grpcPool.shutdown();
  
  console.log('\n✓ Test completed successfully!');
  process.exit(0);
}

// Run the test
testConnectionPool().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});