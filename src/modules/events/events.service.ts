import { Injectable, Inject, NotFoundException, ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { UpdateEventStatusDto } from './dto/update-event-status.dto';
import { JoinEventDto } from './dto/join-event.dto';
import { getMonitoringWindow, isMonitoringWindowOpen } from './monitoring.helper';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class EventsService {
    constructor(
        @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
        private readonly redisService: RedisService,
    ) { }

    async getEventPositions(eventId: number) {
        return this.redisService.getAllParticipantPositions(eventId);
    }

    async createEvent(user: any, dto: CreateEventDto) {
        return this.db.transaction(async (tx) => {
            // 1. Generate unique 6-char alphanumeric code
            const tokenCode = Math.random().toString(36).substring(2, 8).toUpperCase();

            // 2. Insert Event
            const [newEvent] = await tx.insert(schema.events).values({
                name: dto.name,
                description: dto.description,
                category: (dto.category as 'RUNNING' | 'CYCLING') || 'RUNNING',
                status: 'IDLE',
                token: tokenCode, // Keep legacy field populated for compatibility
                maxParticipants: dto.maxParticipants,
                dateEvent: new Date(dto.dateEvent),
                routeGeojson: dto.routeGeojson,
                startTime: new Date(dto.startTime),
                endTime: new Date(dto.endTime),
                monitoringStartOffset: dto.monitoringStartOffset ?? 60,
                monitoringEndOffset: dto.monitoringEndOffset ?? 240,
            }).returning();

            // 3. Insert into Tokens table
            await tx.insert(schema.tokens).values({
                code: tokenCode,
                eventId: newEvent.id,
                status: 'AVAILABLE',
            });

            // 4. Link Creator as Staff
            await tx.insert(schema.eventStaff).values({
                eventId: newEvent.id,
                userId: user.id,
            });

            // 5. Compute monitoring window for response
            const monitoringWindow = getMonitoringWindow(newEvent);

            return {
                success: true,
                data: {
                    ...newEvent,
                    accessCode: tokenCode,
                    monitoringWindow,
                },
            };
        });
    }

    async getAllEvents(user: any) {
        const baseWhere = isNull(schema.events.deletedAt);

        let events: any[];

        if (user.role === 'SUPER_ADMIN') {
            events = await this.db.query.events.findMany({ where: baseWhere });
        } else if (user.role === 'STAFF') {
            const staffLinks = await this.db.query.eventStaff.findMany({
                where: eq(schema.eventStaff.userId, user.id),
            });
            const eventIds = staffLinks.map(link => link.eventId).filter((id): id is number => id !== null);

            if (eventIds.length === 0) return { success: true, data: [] };

            events = await this.db.query.events.findMany({
                where: (events, { inArray, and }) => and(inArray(events.id, eventIds), baseWhere),
            });
        } else {
            events = [];
        }

        // Enrich each event with monitoring window info
        const enriched = events.map(event => ({
            ...event,
            monitoringWindow: getMonitoringWindow(event),
        }));

        return { success: true, data: enriched };
    }

    async getMyEvents(user: any) {
        const joinedEvents = await this.db
            .select({
                id: schema.events.id,
                name: schema.events.name,
                description: schema.events.description,
                category: schema.events.category,
                status: schema.events.status,
                token: schema.events.token,
                currentCount: schema.events.currentCount,
                maxParticipants: schema.events.maxParticipants,
                dateEvent: schema.events.dateEvent,
                routeGeojson: schema.events.routeGeojson,
                startTime: schema.events.startTime,
                endTime: schema.events.endTime,
                monitoringStartOffset: schema.events.monitoringStartOffset,
                monitoringEndOffset: schema.events.monitoringEndOffset,
            })
            .from(schema.events)
            .innerJoin(
                schema.eventParticipants,
                eq(schema.events.id, schema.eventParticipants.eventId)
            )
            .where(
                and(
                    eq(schema.eventParticipants.userId, user.id),
                    isNull(schema.events.deletedAt)
                )
            );

        const enriched = joinedEvents.map(event => ({
            ...event,
            monitoringWindow: getMonitoringWindow(event as any),
        }));

        return { success: true, data: enriched };
    }

    async getEventById(eventId: number, user: any) {
        const event = await this.db.query.events.findFirst({
            where: and(eq(schema.events.id, eventId), isNull(schema.events.deletedAt)),
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

        const monitoringWindow = getMonitoringWindow(event);

        return {
            success: true,
            data: {
                ...event,
                monitoringWindow,
            },
        };
    }

    async updateEventStatus(eventId: number, user: any, dto: UpdateEventStatusDto) {
        const result = await this.getEventById(eventId, user);
        const event = result.data;

        // Validation: START only allowed if monitoring window is open
        if (dto.status === 'START') {
            if (!isMonitoringWindowOpen(event)) {
                throw new BadRequestException(
                    'Cannot start event: monitoring window is not open yet. The current time must be within the monitoring window.',
                );
            }
        }

        // Validation: FINISHED only allowed if current status is START
        if (dto.status === 'FINISHED') {
            if (event.status !== 'START') {
                throw new BadRequestException(
                    'Cannot finish event: event must be in START status first.',
                );
            }
        }

        const [updatedEvent] = await this.db.update(schema.events)
            .set({ status: dto.status as 'IDLE' | 'START' | 'FINISHED' })
            .where(eq(schema.events.id, eventId))
            .returning();

        const monitoringWindow = getMonitoringWindow(updatedEvent);

        return {
            success: true,
            data: {
                ...updatedEvent,
                monitoringWindow,
            },
        };
    }

    async updateEvent(eventId: number, user: any, dto: UpdateEventDto) {
        await this.getEventById(eventId, user); // verifies ownership/existence

        const updateData: any = {};
        if (dto.name !== undefined) updateData.name = dto.name;
        if (dto.description !== undefined) updateData.description = dto.description;
        if (dto.maxParticipants !== undefined) updateData.maxParticipants = dto.maxParticipants;
        if (dto.dateEvent !== undefined) updateData.dateEvent = new Date(dto.dateEvent);
        if (dto.routeGeojson !== undefined) updateData.routeGeojson = dto.routeGeojson;
        if (dto.category !== undefined) updateData.category = dto.category;
        if (dto.startTime !== undefined) updateData.startTime = new Date(dto.startTime);
        if (dto.endTime !== undefined) updateData.endTime = new Date(dto.endTime);
        if (dto.monitoringStartOffset !== undefined) updateData.monitoringStartOffset = dto.monitoringStartOffset;
        if (dto.monitoringEndOffset !== undefined) updateData.monitoringEndOffset = dto.monitoringEndOffset;

        if (Object.keys(updateData).length === 0) {
            return this.getEventById(eventId, user);
        }

        const [updatedEvent] = await this.db.update(schema.events)
            .set(updateData)
            .where(eq(schema.events.id, eventId))
            .returning();

        const monitoringWindow = getMonitoringWindow(updatedEvent);

        return {
            success: true,
            data: {
                ...updatedEvent,
                monitoringWindow,
            },
        };
    }

    async deleteEvent(eventId: number, user: any) {
        await this.getEventById(eventId, user);

        const [deleted] = await this.db.update(schema.events)
            .set({ deletedAt: new Date() })
            .where(eq(schema.events.id, eventId))
            .returning();

        return { success: true, data: deleted };
    }

    async getParticipants(eventId: number) {
        const results = await this.db
            .select({
                id: schema.users.id,
                name: schema.users.name,
                email: schema.users.email,
                phone: schema.users.phone,
                healthInfo: schema.users.healthInfo,
                joinedAt: schema.eventParticipants.joinedAt,
            })
            .from(schema.eventParticipants)
            .innerJoin(schema.users, eq(schema.eventParticipants.userId, schema.users.id))
            .where(eq(schema.eventParticipants.eventId, eventId));

        return { success: true, data: results };
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

            // Allow joining during IDLE or START — tracking is gated by interlock screen
            if (event.status === 'FINISHED') {
                throw new ForbiddenException('Event has already finished');
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

            const monitoringWindow = getMonitoringWindow(updatedEvent);

            return {
                success: true,
                data: {
                    eventId: updatedEvent.id,
                    eventName: updatedEvent.name,
                    category: updatedEvent.category,
                    status: updatedEvent.status,
                    startTime: updatedEvent.startTime,
                    endTime: updatedEvent.endTime,
                    monitoringStartOffset: updatedEvent.monitoringStartOffset,
                    monitoringEndOffset: updatedEvent.monitoringEndOffset,
                    monitoringWindow,
                },
            };
        });
    }

    /**
     * Get raw event without auth checks — for internal use by MqttService / AnalysisService
     */
    async getEventRaw(eventId: number) {
        return this.db.query.events.findFirst({
            where: and(eq(schema.events.id, eventId), isNull(schema.events.deletedAt)),
        });
    }
}
