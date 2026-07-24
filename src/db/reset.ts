import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

async function reset() {
  console.log('Resetting database...');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await pool.query('DROP SCHEMA public CASCADE;');
    await pool.query('CREATE SCHEMA public;');
    console.log('✅ Database schema dropped and recreated successfully!');
  } catch (error) {
    console.error('❌ Failed to reset database:', error);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

void reset();
