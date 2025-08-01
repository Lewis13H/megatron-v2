const { execSync, spawn } = require('child_process');
const path = require('path');

console.log('Starting dashboard in development mode...');

// Function to find and kill processes on port 3000
function killProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      // Windows: Find process using the port
      const netstatOutput = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const lines = netstatOutput.split('\n');
      
      const pids = new Set();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length > 0 && line.includes('LISTENING')) {
          const pid = parts[parts.length - 1];
          if (pid && !isNaN(pid)) {
            pids.add(pid);
          }
        }
      }
      
      // Kill each process
      for (const pid of pids) {
        try {
          console.log(`Killing existing process on port ${port} (PID: ${pid})...`);
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
          console.log(`Process ${pid} terminated.`);
        } catch (e) {
          // Process might already be dead
        }
      }
    } else {
      // Unix/Linux/Mac
      try {
        execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' });
        console.log(`Killed existing process on port ${port}.`);
      } catch (e) {
        // No process found on port
      }
    }
  } catch (e) {
    // No process found on port
    console.log(`No existing process found on port ${port}.`);
  }
}

// Kill any existing process on port 3000
killProcessOnPort(3000);

// Wait a moment for the port to be fully released
setTimeout(() => {
  console.log('Starting server in transpile-only mode...');
  
  // Start the server using node with ts-node register
  const server = spawn('node', ['-r', 'ts-node/register/transpile-only', 'src/api/server.ts'], {
    stdio: 'inherit',
    shell: true,
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      TS_NODE_TRANSPILE_ONLY: 'true',
      NODE_ENV: 'development'
    }
  });
  
  // Handle exit
  server.on('error', (err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
  
  // Forward signals to child process
  process.on('SIGINT', () => {
    server.kill('SIGINT');
    process.exit();
  });
  
  process.on('SIGTERM', () => {
    server.kill('SIGTERM');
    process.exit();
  });
  
}, 1000);