import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://dashly_user:dashly_password@localhost:5432/dashly_db',
  });
  await client.connect();
  console.log('Connected to PostgreSQL database');

  await client.query(`
    ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
    ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS total_distance_meters INTEGER;
    ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS avg_speed_kmh DOUBLE PRECISION;
    ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS max_speed_kmh DOUBLE PRECISION;
    ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS elevation_gain_meters INTEGER;
    ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP;
  `);

  console.log('✅ Successfully added missing race summary columns to event_participants table!');
  await client.end();
}

run().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
