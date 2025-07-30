import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

// Create a singleton database connection pool
let dbPool: Pool | null = null;

export function getDbPool(): Pool {
  if (!dbPool) {
    dbPool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'megatron_v2',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
      max: 20, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
      connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection cannot be established
    });

    // Handle pool errors
    dbPool.on('error', (err) => {
      console.error('Unexpected error on idle database client', err);
    });

    // Log when connected
    dbPool.on('connect', () => {
      console.log('Database pool: new client connected');
    });
  }

  return dbPool;
}

// Graceful shutdown
export async function closeDbPool(): Promise<void> {
  if (dbPool) {
    await dbPool.end();
    dbPool = null;
    console.log('Database pool closed');
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  await closeDbPool();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeDbPool();
  process.exit(0);
});