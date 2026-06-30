import { Injectable, Logger, Inject } from '@nestjs/common';
import { EventsGateway } from '../websocket/events.gateway';
import { RedisService } from '../redis/redis.service';
import { IdentityCacheService } from '../tracking/identity-cache.service';
import { RawIngestPayload } from '../common/interfaces/tracking-event.interface';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq } from 'drizzle-orm';

/**
 * StatusHandlerService — Processes LWT (Last Will and Testament) or manual disconnects,
 * AND handles ONLINE connects to transition participants to TRACKING.
 */
@Injectable()
export class StatusHandlerService {
  private readonly logger = new Logger(StatusHandlerService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly gateway: EventsGateway,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async handle(raw: RawIngestPayload): Promise<void> {
    const { eventId, participantId, userId, status } = raw;

    if (status !== 'OFFLINE' && status !== 'ONLINE') return;

    this.logger.log(
      `[Status Handler] 🔌 Status ${status} received for participant ${participantId}`,
    );

    if (status === 'ONLINE') {
      // Check Event Status
      const ev = await this.db.query.events.findFirst({
        where: eq(schema.events.id, eventId),
      });

      if (!ev || ev.status !== 'LIVE') {
        this.logger.warn(
          `[Status Handler] Participant ${participantId} tried to go ONLINE but event ${eventId} is not LIVE`,
        );
        return;
      }

      // Check Participant State
      const participant = await this.db.query.eventParticipants.findFirst({
        where: eq(schema.eventParticipants.id, participantId),
      });

      // Update Redis presence regardless of state to ensure accurate online tracking
      await this.redisService.setParticipantOnline(eventId, participantId);

      if (
        !participant ||
        participant.participantState === 'FINISHED' ||
        participant.participantState === 'FROZEN'
      ) {
        this.logger.warn(
          `[Status Handler] Participant ${participantId} tried to go ONLINE but is ${participant?.participantState}. Ignoring transition to TRACKING.`,
        );
        return;
      }

      // Update Database only if safe
      await this.db
        .update(schema.eventParticipants)
        .set({ participantState: 'TRACKING' })
        .where(eq(schema.eventParticipants.id, participantId));

      this.logger.log(
        `[Status Handler] ✅ Participant ${participantId} successfully transitioned to TRACKING state`,
      );
      return;
    }

    if (status === 'OFFLINE') {
      // 2. Update Redis state
      await this.redisService.setParticipantOffline(eventId, participantId);

      // 3. Fetch last known position to broadcast accurately
      const pos = await this.redisService.getParticipantPosition(
        eventId,
        participantId,
      );
      const stats = await this.redisService.getParticipantStats(participantId);

      const participant = await this.db.query.eventParticipants.findFirst({
        where: eq(schema.eventParticipants.id, participantId),
      });

      if (pos) {
        this.gateway.broadcastPositionUpdate(eventId, {
          participantId,
          userId,
          eventId,
          lat: pos.lat,
          lng: pos.lng,
          speed: stats.speed ? parseFloat(stats.speed) : 0,
          status: 'inactive',
          state: participant?.participantState || 'TRACKING',
          battery: stats.battery ? parseInt(stats.battery, 10) : 100,
          isOffline: true,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}
