import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DB_CONNECTION = 'DB_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: DB_CONNECTION,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const connectionString = configService.get<string>('DATABASE_URL');
        const pool = new Pool({
          connectionString,
        });

        try {
          await pool.query(`
            ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
            ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS total_distance_meters INTEGER;
            ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS avg_speed_kmh DOUBLE PRECISION;
            ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS max_speed_kmh DOUBLE PRECISION;
            ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS elevation_gain_meters INTEGER;
            ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP;
          `);
          console.log(
            '[DatabaseModule] ✅ Auto-verified DB schema columns for event_participants.',
          );
        } catch (err) {
          console.error('[DatabaseModule] ⚠️ Schema auto-check warning:', err);
        }

        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DB_CONNECTION],
})
export class DatabaseModule {}
