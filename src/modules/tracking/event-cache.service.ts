import { Injectable, Logger, Inject } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq } from 'drizzle-orm';

/**
 * EventCacheService — Caches event metadata (status, category).
 *
 * Uses Redis with a 10-second TTL so the MQTT pipeline does not
 * hit PostgreSQL on every message to check if an event is active.
 */
@Injectable()
export class EventCacheService {
  private readonly logger = new Logger(EventCacheService.name);

  constructor(
    private readonly redisService: RedisService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /** Returns the event status ('IDLE' | 'LIVE' | 'FINISHED') or null if not found. */
  async getEventStatus(eventId: number): Promise<string | null> {
    // 1. Check Redis cache (10s TTL)
    const cached = await this.redisService.getCachedEventStatus(eventId);
    if (cached !== null) {
      return cached;
    }

    // 2. Fallback to DB
    const event = await this.db.query.events.findFirst({
      where: eq(schema.events.id, eventId),
      columns: { status: true },
    });

    if (!event) {
      this.logger.warn(`Event ${eventId} not found in DB`);
      return null;
    }

    // 3. Populate cache
    await this.redisService.setCachedEventStatus(eventId, event.status);

    return event.status;
  }
}
