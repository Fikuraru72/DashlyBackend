import { Injectable, Logger, Inject } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { DB_CONNECTION } from '../../db/database.module';
import { and, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';

/**
 * IdentityCacheService — Resolves participantId → userId.
 *
 * Uses Redis as an LRU cache (1-hour TTL) with DB fallback.
 * Eliminates DB queries from the MQTT ingestion hot-path.
 */
@Injectable()
export class IdentityCacheService {
  private readonly logger = new Logger(IdentityCacheService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Resolve userId to participantId.
   * Returns null if the participant does not exist.
   */
  async resolveParticipantId(eventId: number, userId: number): Promise<number | null> {
    const cacheKey = `${eventId}:${userId}`;

    // 1. Check Redis cache
    const cached = await this.redisService.getCachedParticipant(cacheKey as any);
    if (cached !== null) {
      return cached;
    }

    // 2. Fallback to DB
    const participant = await this.db.query.eventParticipants.findFirst({
      where: and(
        eq(schema.eventParticipants.eventId, eventId),
        eq(schema.eventParticipants.userId, userId),
      ),
    });

    if (!participant) {
      this.logger.warn(`Participant not found in DB for Event ${eventId}, User ${userId}`);
      return null;
    }

    // 3. Populate cache for next time
    await this.redisService.setCachedParticipant(cacheKey as any, participant.id);

    return participant.id;
  }
}
