const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  try {
    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_releases (
        id SERIAL PRIMARY KEY,
        version VARCHAR(50) NOT NULL,
        build_number INTEGER NOT NULL,
        file_url VARCHAR(255) NOT NULL,
        release_notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    console.log("Table created");
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}
run();
