import { Injectable, Inject, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventStatusDto } from './dto/update-event-status.dto';
import { JoinEventDto } from './dto/join-event.dto';

@Injectable()
export class EventsService {
    constructor(
        @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    ) { }

    async createEvent(user: any, dto: CreateEventDto) {
        const token = Math.random().toString(36).substring(2, 10).toUpperCase();

        const [newEvent] = await this.db.insert(schema.events).values({
            name: dto.name,
            description: dto.description,
            status: 'IDLE',
            token,
            currentCount: 0,
            maxParticipants: dto.maxParticipants,
        }).returning();

        // Link SUPER_ADMIN or STAFF to the event
        await this.db.insert(schema.eventStaff).values({
            eventId: newEvent.id,
            userId: user.id,
        });

        return newEvent;
    }

    async getAllEvents(user: any) {
        if (user.role === 'SUPER_ADMIN') {
            return this.db.query.events.findMany();
        }

        if (user.role === 'STAFF') {
            const staffLinks = await this.db.query.eventStaff.findMany({
                where: eq(schema.eventStaff.userId, user.id),
            });
            const eventIds = staffLinks.map(link => link.eventId);

            if (eventIds.length === 0) return [];

            return this.db.query.events.findMany({
                where: (events, { inArray }) => inArray(events.id, eventIds),
            });
        }

        return [];
    }

    async getEventById(eventId: number, user: any) {
        const event = await this.db.query.events.findFirst({
            where: eq(schema.events.id, eventId),
        });

        if (!event) {
            throw new NotFoundException('Event not found');
        }

        if (user.role === 'STAFF') {
            const isStaff = await this.db.query.eventStaff.findFirst({
                where: and(
                    eq(schema.eventStaff.eventId, eventId),
                    eq(schema.eventStaff.userId, user.id),
                ),
            });

            if (!isStaff) throw new ForbiddenException('Not assigned to this event');
        }

        return event;
    }

    async updateEventStatus(eventId: number, user: any, dto: UpdateEventStatusDto) {
        await this.getEventById(eventId, user); // verifies ownership/existence

        const [updatedEvent] = await this.db.update(schema.events)
            .set({ status: dto.status })
            .where(eq(schema.events.id, eventId))
            .returning();

        return updatedEvent;
    }

    async deleteEvent(eventId: number, user: any) {
        await this.getEventById(eventId, user);

        // Delete related records first or use CASCADE in real DB
        await this.db.delete(schema.eventStaff).where(eq(schema.eventStaff.eventId, eventId));
        await this.db.delete(schema.eventParticipants).where(eq(schema.eventParticipants.eventId, eventId));

        const [deleted] = await this.db.delete(schema.events).where(eq(schema.events.id, eventId)).returning();
        return deleted;
    }

    async joinEvent(user: any, dto: JoinEventDto) {
        return this.db.transaction(async (tx) => {
            // 1. Find the event
            const event = await tx.query.events.findFirst({
                where: eq(schema.events.token, dto.token),
            });

            if (!event) {
                throw new NotFoundException('Event not found or invalid token');
            }

            if (event.status !== 'LIVE') {
                throw new ForbiddenException('Event is not LIVE for joining');
            }

            // 2. Check Capacity
            if (event.currentCount >= event.maxParticipants) {
                throw new ForbiddenException('Event has reached maximum capacity');
            }

            // 3. Prevent Duplicates
            const existingParticipant = await tx.query.eventParticipants.findFirst({
                where: and(
                    eq(schema.eventParticipants.eventId, event.id),
                    eq(schema.eventParticipants.userId, user.id),
                ),
            });

            if (existingParticipant) {
                throw new ConflictException('You have already joined this event');
            }

            // 4. Atomic Update
            await tx.insert(schema.eventParticipants).values({
                eventId: event.id,
                userId: user.id,
            });

            const [updatedEvent] = await tx.update(schema.events)
                .set({ currentCount: event.currentCount + 1 })
                .where(eq(schema.events.id, event.id))
                .returning();

            return {
                eventId: updatedEvent.id,
                success: true,
            };
        });
    }
}
