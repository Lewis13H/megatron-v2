import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

async function checkConnections() {
  // Create a new connection just for checking
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: 'postgres', // Connect to postgres db to check
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    max: 1
  });

  try {
    const result = await pool.query(`
      SELECT 
        pid,
        usename,
        application_name,
        client_addr,
        state,
        query_start,
        state_change,
        NOW() - state_change as idle_time
      FROM pg_stat_activity
      WHERE datname = 'megatron_v2'
      ORDER BY state_change DESC
    `);

    console.log(`\n📊 Active connections to megatron_v2: ${result.rows.length}\n`);
    
    result.rows.forEach((conn, index) => {
      console.log(`Connection ${index + 1}:`);
      console.log(`  PID: ${conn.pid}`);
      console.log(`  User: ${conn.usename}`);
      console.log(`  App: ${conn.application_name || 'none'}`);
      console.log(`  State: ${conn.state}`);
      console.log(`  Idle time: ${conn.idle_time || 'active'}`);
      console.log('---');
    });

    // Show connection limit
    const limitResult = await pool.query(`
      SELECT setting FROM pg_settings WHERE name = 'max_connections'
    `);
    console.log(`\nMax connections allowed: ${limitResult.rows[0].setting}`);

  } catch (error) {
    console.error('Error checking connections:', error);
  } finally {
    await pool.end();
  }
}

checkConnections();