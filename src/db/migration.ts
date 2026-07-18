import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    const client = await pool.connect();
    await client.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS altitude_profile jsonb;');
    console.log('Column altitude_profile added successfully');
    client.release();
  } catch (error) {
    console.error('Migration failed', error);
  } finally {
    await pool.end();
  }
}

migrate();
