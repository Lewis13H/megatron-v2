import express from 'express';
import cors from 'cors';
import path from 'path';
import dashboardApi from './dashboard-api';

const app = express();
const PORT = process.env.API_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Get absolute path to dashboard directory
const projectRoot = path.resolve(process.cwd());
const dashboardPath = path.join(projectRoot, 'dashboard');
console.log('Serving dashboard from:', dashboardPath);

// Serve static dashboard files
app.use(express.static(dashboardPath));

// API routes with technical scoring
app.use('/api', dashboardApi);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: 'v2',
    scoring: 'calculate_technical_score',
    timestamp: new Date() 
  });
});

// Error handling middleware
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Dashboard API server running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard UI with technical scoring available at http://localhost:${PORT}`);
  console.log(`✨ Features: Real-time sell-off detection, scoring range (-60 to +75 SR)`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});