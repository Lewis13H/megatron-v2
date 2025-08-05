import { getDbPool } from '../database/connection';

async function closeAllConnections() {
  console.log('Closing all database connections...');
  
  try {
    const pool = getDbPool();
    await pool.end();
    console.log('✅ All database connections closed');
  } catch (error) {
    console.error('Error closing connections:', error);
  }
  
  process.exit(0);
}

closeAllConnections();