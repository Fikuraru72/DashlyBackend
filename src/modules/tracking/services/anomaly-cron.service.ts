import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../../redis/redis.service';
import { DB_CONNECTION } from '../../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { EventsGateway } from '../../websocket/events.gateway';

@Injectable()
export class AnomalyCronService {
  private readonly logger = new Logger(AnomalyCronService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    private readonly eventsGateway: EventsGateway,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron() {
    // this.logger.debug('Running STUCK anomaly detection cron job...');
    try {
      // 1. Get all active events from DB
      const activeEvents = await this.db.query.events.findMany({
        where: eq(schema.events.status, 'START'),
      });

      for (const event of activeEvents) {
        // 2. Get all participants for this event from Redis
        const participants = await this.redisService.getAllParticipantPositions(
          event.id,
        );

        for (const p of participants) {
          // Skip if they are already manually offline
          if (p.isOffline === 'true') continue;

          if (p.last_moved || p.last_seen) {
            const lastActivity = new Date(p.last_moved || p.last_seen);
            const now = new Date();
            const diffMs = now.getTime() - lastActivity.getTime();
            const diffMinutes = diffMs / (1000 * 60);

            // 3. If no updates for > 5 mins, mark as STUCK
            if (diffMinutes > 5) {
              this.logger.warn(
                `[ANOMALY CRON] User ${p.userId} in Event ${event.id} hasn't sent data for ${Math.round(diffMinutes)} mins.`,
              );

              // Check if an anomaly was already recorded recently to avoid spamming
              // We do a simple check: only insert if it's been exactly 5-6 mins
              // OR we just insert and let the frontend handle deduplication.
              // Better: query DB if we already inserted STUCK recently.
              const recentAnomalies = await this.db.query.anomalies.findMany({
                where: (anomalies, { eq, and, gte }) =>
                  and(
                    eq(anomalies.eventId, event.id),
                    eq(anomalies.userId, p.userId),
                    eq(anomalies.type, 'STUCK'),
                    gte(
                      anomalies.timestamp,
                      new Date(Date.now() - 5 * 60 * 1000),
                    ), // within last 5 mins
                  ),
                limit: 1,
              });

              if (recentAnomalies.length === 0) {
                // Record the anomaly
                const [anomaly] = await this.db
                  .insert(schema.anomalies)
                  .values({
                    eventId: event.id,
                    userId: p.userId,
                    latitude: p.lat,
                    longitude: p.lng,
                    type: 'STUCK',
                    reason: `No telemetry received for ${Math.round(diffMinutes)} minutes. User may be disconnected or stuck.`,
                  })
                  .returning();

                // Broadcast to frontend
                this.eventsGateway.broadcastAnomalyDetected(event.id, {
                  ...anomaly,
                  userId: p.userId,
                  type: 'STUCK',
                  message: `No telemetry received for ${Math.round(diffMinutes)} minutes. User may be disconnected or stuck.`,
                  timestamp: new Date().toISOString(),
                });
              }
            }
          }
        }
      }
    } catch (error) {
      this.logger.error('Error in STUCK anomaly cron job', error);
    }
  }
}
