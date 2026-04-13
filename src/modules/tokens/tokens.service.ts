import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq, and } from 'drizzle-orm';

@Injectable()
export class TokensService {
  constructor(@Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>) {}

  async redeemToken(code: string, userId: number) {
    return await this.db.transaction(async (tx) => {
      // 1. Find and Lock Token Record
      const [tokenRecord] = await tx.select()
        .from(schema.tokens)
        .where(eq(schema.tokens.code, code))
        .limit(1);

      if (!tokenRecord) {
        throw new NotFoundException('Token not found');
      }

      if (tokenRecord.status === 'USED') {
        throw new BadRequestException('Token has already been used');
      }

      // 2. Check Event Existence and Capacity
      const [event] = await tx.select()
        .from(schema.events)
        .where(eq(schema.events.id, tokenRecord.eventId))
        .limit(1);

      if (!event) {
        throw new NotFoundException('Associated event not found');
      }

      if (event.currentCount >= event.maxParticipants) {
        throw new BadRequestException('Event has reached maximum capacity');
      }

      // 3. Mark Token as USED
      await tx.update(schema.tokens)
        .set({ status: 'USED', userId })
        .where(eq(schema.tokens.code, code));

      // 4. Add Participant (Atomic Insert with Unique Conflict Handling)
      // Note: eventParticipants has a unique constraint on (eventId, userId)
      await tx.insert(schema.eventParticipants).values({
        eventId: tokenRecord.eventId,
        userId,
      }).onConflictDoNothing();

      // 5. Increment Event Counter
      await tx.update(schema.events)
        .set({ currentCount: event.currentCount + 1 })
        .where(eq(schema.events.id, tokenRecord.eventId));

      return { 
        success: true,
        message: 'Token redeemed successfully', 
        eventId: tokenRecord.eventId,
        eventName: event.name 
      };
    });
  }
}
