import { Injectable, Logger, Inject } from '@nestjs/common';
import { EventsGateway } from '../websocket/events.gateway';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq } from 'drizzle-orm';
import { RawIngestPayload } from '../common/interfaces/tracking-event.interface';

import { RedisService } from '../redis/redis.service';

/**
 * SosHandlerService — FAST PATH for SOS emergencies.
 *
 * SOS bypasses the BullMQ queue entirely to guarantee near-zero latency.
 * It immediately updates the DB state and emits the WebSocket broadcast.
 */
@Injectable()
export class SosHandlerService {
  private readonly logger = new Logger(SosHandlerService.name);

  constructor(
    private readonly gateway: EventsGateway,
    private readonly redisService: RedisService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async handle(raw: RawIngestPayload): Promise<void> {
    const { eventId, participantId, userId } = raw;

    this.logger.warn(`[SOS Fast-Path] 🚨 Processing SOS for participant ${participantId}`);

    const latNum = parseFloat(raw.lat as string);
    const lngNum = parseFloat(raw.lng as string);

    // 2. Immediate DB update & Redis update (Atomic)
    try {
      // Set PostgreSQL state
      await this.db
        .update(schema.eventParticipants)
        .set({ participantState: 'FROZEN' })
        .where(eq(schema.eventParticipants.id, participantId));

      // Set Redis state to prevent Enrichment Engine from overwriting it back to TRACKING
      const statsKey = `participant_stats:${participantId}`;
      await this.redisService['redisClient'].hset(statsKey, 'participantState', 'FROZEN');

      // Persist Anomaly to DB
      await this.db.insert(schema.anomalies).values({
        eventId,
        userId,
        latitude: latNum,
        longitude: lngNum,
        type: 'SOS_EMERGENCY',
        reason: 'Participant triggered manual SOS from mobile app.',
      });
    } catch (error) {
      this.logger.error(`[SOS Fast-Path] ❌ Failed to freeze state for ${participantId}`, error);
      // We still broadcast even if DB fails, as lives could be at stake
    }

    // 3. Immediate WS broadcast
    this.gateway.broadcastSosTriggered(eventId, {
      participantId,
      userId,
      lat: latNum,
      lng: lngNum,
      timestamp: new Date().toISOString(),
    });

    // Note: In the future, we could also publish an SosEvent to the BullMQ
    // stream here for async audit logging, without blocking the response.
  }
}
