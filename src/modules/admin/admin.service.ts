import { Injectable, Inject } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq, isNull, inArray } from 'drizzle-orm';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class AdminService {
  constructor(
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    private readonly redisService: RedisService,
  ) {}

  async getDashboardStats() {
    // Basic stats from DB
    const activeEventsResult = await this.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.status, 'START'));

    const activeEventIds = activeEventsResult.map((e) => e.id);

    let activeRunners = 0;
    let finishedRunners = 0;
    let sosAlerts = 0; // Requires anomalies table query
    let offRouteParticipants = 0;

    if (activeEventIds.length > 0) {
      // Get participant states
      const participants = await this.db
        .select({
          state: schema.eventParticipants.participantState,
        })
        .from(schema.eventParticipants)
        .where(inArray(schema.eventParticipants.eventId, activeEventIds));

      activeRunners = participants.filter((p) => p.state === 'TRACKING').length;
      finishedRunners = participants.filter(
        (p) => p.state === 'FINISHED',
      ).length;

      // Get SOS alerts
      const anomalies = await this.db
        .select()
        .from(schema.anomalies)
        .where(inArray(schema.anomalies.eventId, activeEventIds));
      sosAlerts = anomalies.filter(
        (a) => a.type === 'SOS_EMERGENCY' || a.type === 'SOS_ALERT',
      ).length;

      // We can also query redis for off_route_cooldown keys to estimate live off-route,
      // but for MVP we can just query the anomalies table or assume.
      offRouteParticipants = anomalies.filter(
        (a) => a.type === 'OFF_ROUTE',
      ).length;
    }

    return {
      success: true,
      data: {
        totalActiveEvents: activeEventIds.length,
        activeRunners,
        finishedRunners,
        sosAlerts,
        offRouteParticipants,
        systemHealth: 'ONLINE', // In a real app, query Redis/Postgres ping
      },
    };
  }

  // To be called by WebSocket Gateway
  async getQueueStats() {
    // Assuming BullMQ, we would inject the queue instances here,
    // but for now we can mock or use Redis service to get approximate lengths if possible.
    // We will leave this as a placeholder since injecting queues dynamically requires bullmq.
    return {
      rawLength: 0,
      enrichedLength: 0,
    };
  }
}
