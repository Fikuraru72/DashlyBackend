import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq, and, isNull, asc } from 'drizzle-orm';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { UpdateEventStatusDto } from './dto/update-event-status.dto';
import {
  getMonitoringWindow,
  isMonitoringWindowOpen,
} from './monitoring.helper';
import { RedisService } from '../redis/redis.service';
import { OsrmService } from './osrm.service';
import { JwtService } from '@nestjs/jwt';
import * as qrcode from 'qrcode';
import * as bcrypt from 'bcrypt';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    private readonly redisService: RedisService,
    private readonly jwtService: JwtService,
    private readonly osrmService: OsrmService,
  ) { }

  async getEventPositions(eventId: number) {
    return this.redisService.getAllParticipantPositions(eventId);
  }

  /**
   * Get live positions from Redis, enriched with participant names from DB.
   * Used by dashboard on initial load / refresh to restore markers instantly.
   */
  async getLivePositions(eventId: number) {
    const positions =
      await this.redisService.getAllParticipantPositions(eventId);

    // Get real names and state from DB in a single query
    const participantRows = await this.db
      .select({
        participantId: schema.eventParticipants.id,
        userId: schema.eventParticipants.userId,
        name: schema.users.name,
        state: schema.eventParticipants.participantState,
        bibNumber: schema.eventParticipants.bibNumber,
      })
      .from(schema.eventParticipants)
      .innerJoin(
        schema.users,
        eq(schema.eventParticipants.userId, schema.users.id),
      )
      .where(eq(schema.eventParticipants.eventId, eventId));

    const infoMap = new Map(participantRows.map((p) => [p.participantId, p]));

    return positions.map((p) => {
      const info = infoMap.get(p.participantId);
      return {
        ...p,
        userId: info?.userId || p.userId, // Fix: Overwrite userId from DB if Redis had the wrong one
        isOffline: p.isOffline === 'true' || p.isOffline === true,
        name: info?.name || `Runner ${info?.userId || p.userId}`,
        state: info?.state || 'TRACKING',
        bibNumber: info?.bibNumber || '-',
      };
    });
  }

  /**
   * Fetch full path history for all participants in an event.
   * Returns a map of userId -> array of [lng, lat] coordinates.
   */
  async getEventPathHistory(eventId: number) {
    const logs = await this.db
      .select({
        userId: schema.locationLogs.userId,
        lat: schema.locationLogs.latitude,
        lng: schema.locationLogs.longitude,
      })
      .from(schema.locationLogs)
      .where(eq(schema.locationLogs.eventId, eventId))
      .orderBy(asc(schema.locationLogs.capturedAt));

    const historyMap = new Map<number, number[][]>();
    for (const log of logs) {
      if (!historyMap.has(log.userId)) {
        historyMap.set(log.userId, []);
      }
      historyMap.get(log.userId)!.push([log.lng, log.lat]); // GeoJSON format: [lng, lat]
    }

    const result: Record<number, number[][]> = {};
    for (const [userId, path] of historyMap.entries()) {
      result[userId] = path;
    }
    return result;
  }

  async createEvent(user: any, dto: CreateEventDto) {
    const category = (dto.category as 'RUNNING' | 'CYCLING') || 'RUNNING';
    const normalizedRoute = dto.routeGeojson
      ? await this.osrmService.normalizeRoute(category, dto.routeGeojson)
      : null;

    return this.db.transaction(async (tx) => {
      // 1. Generate unique 6-char alphanumeric code
      const tokenCode = Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();

      // 2. Insert Event
      const [newEvent] = await tx
        .insert(schema.events)
        .values({
          name: dto.name,
          description: dto.description,
          category,
          status: 'IDLE',
          token: tokenCode, // Keep legacy field populated for compatibility
          maxParticipants: dto.maxParticipants,
          dateEvent: new Date(dto.dateEvent),
          routeGeojson: normalizedRoute?.geoJson ?? dto.routeGeojson,
          totalDistanceMeters:
            normalizedRoute?.totalDistanceMeters ?? dto.totalDistanceMeters,
          totalElevationMeters: dto.totalElevationMeters,
          startTime: new Date(dto.startTime),
          endTime: new Date(dto.endTime),
          registrationOpen: dto.registrationOpen
            ? new Date(dto.registrationOpen)
            : null,
          registrationClose: dto.registrationClose
            ? new Date(dto.registrationClose)
            : null,
          locationName: dto.locationName,
          city: dto.city,
          province: dto.province,
          latitude: dto.latitude,
          longitude: dto.longitude,
          bannerImage: dto.bannerImage,
          monitoringStartOffset: dto.monitoringStartOffset ?? 60,
          monitoringEndOffset: dto.monitoringEndOffset ?? 240,
        })
        .returning();

      // Tokens table insert removed since we are moving away from tokens

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

  async getPublicEvents() {
    const events = await this.db.query.events.findMany({
      where: isNull(schema.events.deletedAt),
      columns: {
        id: true,
        name: true,
        description: true,
        category: true,
        dateEvent: true,
        maxParticipants: true,
        currentCount: true,
        bannerImage: true,
        locationName: true,
        city: true,
        province: true,
        latitude: true,
        longitude: true,
        status: true,
        registrationOpen: true,
        registrationClose: true,
      },
    });

    return {
      success: true,
      data: events.map((e) => ({
        id: e.id,
        name: e.name,
        banner: e.bannerImage,
        description: e.description,
        category: e.category,
        date: e.dateEvent,
        quota: e.maxParticipants,
        remainingQuota: e.maxParticipants - e.currentCount,
        location: {
          name: e.locationName,
          city: e.city,
          province: e.province,
          lat: e.latitude,
          lng: e.longitude,
        },
        registrationStatus: e.status,
      })),
    };
  }

  async getPublicEventById(eventId: number) {
    const event = await this.db.query.events.findFirst({
      where: and(
        eq(schema.events.id, eventId),
        isNull(schema.events.deletedAt),
      ),
      columns: {
        id: true,
        name: true,
        description: true,
        category: true,
        dateEvent: true,
        maxParticipants: true,
        currentCount: true,
        bannerImage: true,
        locationName: true,
        city: true,
        province: true,
        latitude: true,
        longitude: true,
        status: true,
        registrationOpen: true,
        registrationClose: true,
        startTime: true,
        endTime: true,
        routeGeojson: true,
      },
    });

    if (!event) return { success: false, message: 'Event not found' };

    return {
      success: true,
      data: {
        id: event.id,
        name: event.name,
        banner: event.bannerImage,
        description: event.description,
        category: event.category,
        dateEvent: event.dateEvent, // The frontend expects dateEvent
        maxParticipants: event.maxParticipants,
        currentCount: event.currentCount,
        quota: event.maxParticipants,
        remainingQuota: event.maxParticipants - event.currentCount,
        locationName: event.locationName, // Added for frontend backward compatibility
        city: event.city,
        province: event.province,
        location: {
          name: event.locationName,
          city: event.city,
          province: event.province,
          lat: event.latitude,
          lng: event.longitude,
        },
        registrationStatus: event.status,
        registrationOpen: event.registrationOpen,
        registrationClose: event.registrationClose,
        startTime: event.startTime,
        endTime: event.endTime,
        routeGeojson: event.routeGeojson,
      },
    };
  }

  async getAllEvents(user: any) {
    const baseWhere = isNull(schema.events.deletedAt);

    let events: any[];

    if (user.role === 'SUPER_ADMIN' || user.role === 'STAFF') {
      events = await this.db.query.events.findMany({ where: baseWhere });
    } else {
      events = [];
    }

    // Enrich each event with monitoring window info
    const enriched = events.map((event) => ({
      ...event,
      monitoringWindow: getMonitoringWindow(event),
    }));

    return { success: true, data: enriched };
  }

  async getExploreEvents() {
    const baseWhere = isNull(schema.events.deletedAt);
    const events = await this.db.query.events.findMany({ where: baseWhere });

    const enriched = events.map((event) => ({
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
        participantState: schema.eventParticipants.participantState,
        bibNumber: schema.eventParticipants.bibNumber,
      })
      .from(schema.events)
      .innerJoin(
        schema.eventParticipants,
        eq(schema.events.id, schema.eventParticipants.eventId),
      )
      .where(
        and(
          eq(schema.eventParticipants.userId, user.id),
          isNull(schema.events.deletedAt),
        ),
      );

    const enriched = joinedEvents.map((event) => ({
      ...event,
      monitoringWindow: getMonitoringWindow(event as any),
      bibNumber: event.bibNumber,
    }));

    return { success: true, data: enriched };
  }

  async getEventById(eventId: number, user: any) {
    const event = await this.db.query.events.findFirst({
      where: and(
        eq(schema.events.id, eventId),
        isNull(schema.events.deletedAt),
      ),
    });

    if (!event) {
      throw new NotFoundException('Event not found');
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

  async updateEventStatus(
    eventId: number,
    user: any,
    dto: UpdateEventStatusDto,
  ) {
    const result = await this.getEventById(eventId, user);
    const event = result.data;

    // Validation: LIVE only allowed if monitoring window is open
    if (dto.status === 'LIVE') {
      const window = getMonitoringWindow(event);
      if (!window || !window.isOpen) {
        throw new BadRequestException(
          'Cannot start event: monitoring window is not open yet. The current time must be within the monitoring window.',
        );
      }
    }

    // Validation: FINISHED only allowed if current status is LIVE
    if (dto.status === 'FINISHED') {
      if (event.status !== 'LIVE') {
        throw new BadRequestException(
          'Cannot finish event: event must be in LIVE status first.',
        );
      }
    }

    const [updatedEvent] = await this.db
      .update(schema.events)
      .set({ status: dto.status as any })
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
    const existing = await this.getEventById(eventId, user); // verifies ownership/existence

    const updateData: any = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.maxParticipants !== undefined)
      updateData.maxParticipants = dto.maxParticipants;
    if (dto.dateEvent !== undefined)
      updateData.dateEvent = new Date(dto.dateEvent);
    if (dto.routeGeojson !== undefined) {
      const category = (dto.category ?? existing.data.category) as
        | 'RUNNING'
        | 'CYCLING';
      const normalizedRoute = await this.osrmService.normalizeRoute(
        category,
        dto.routeGeojson,
      );
      updateData.routeGeojson = normalizedRoute?.geoJson ?? dto.routeGeojson;
      if (normalizedRoute) {
        updateData.totalDistanceMeters = normalizedRoute.totalDistanceMeters;
      }
    }
    if (dto.category !== undefined) updateData.category = dto.category;
    if (dto.startTime !== undefined)
      updateData.startTime = new Date(dto.startTime);
    if (dto.endTime !== undefined) updateData.endTime = new Date(dto.endTime);
    if (dto.monitoringStartOffset !== undefined)
      updateData.monitoringStartOffset = dto.monitoringStartOffset;
    if (dto.monitoringEndOffset !== undefined)
      updateData.monitoringEndOffset = dto.monitoringEndOffset;
    if (dto.totalDistanceMeters !== undefined)
      updateData.totalDistanceMeters = dto.totalDistanceMeters;
    if (dto.totalElevationMeters !== undefined)
      updateData.totalElevationMeters = dto.totalElevationMeters;
    if (dto.registrationOpen !== undefined)
      updateData.registrationOpen = dto.registrationOpen
        ? new Date(dto.registrationOpen)
        : null;
    if (dto.registrationClose !== undefined)
      updateData.registrationClose = dto.registrationClose
        ? new Date(dto.registrationClose)
        : null;
    if (dto.locationName !== undefined)
      updateData.locationName = dto.locationName;
    if (dto.city !== undefined) updateData.city = dto.city;
    if (dto.province !== undefined) updateData.province = dto.province;
    if (dto.latitude !== undefined) updateData.latitude = dto.latitude;
    if (dto.longitude !== undefined) updateData.longitude = dto.longitude;
    if (dto.bannerImage !== undefined) updateData.bannerImage = dto.bannerImage;

    if (Object.keys(updateData).length === 0) {
      return this.getEventById(eventId, user);
    }

    const [updatedEvent] = await this.db
      .update(schema.events)
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

    const [deleted] = await this.db
      .update(schema.events)
      .set({ deletedAt: new Date() })
      .where(eq(schema.events.id, eventId))
      .returning();

    return { success: true, data: deleted };
  }

  async getEventAnomalies(eventId: number) {
    const recentAnomalies = await this.db.query.anomalies.findMany({
      where: eq(schema.anomalies.eventId, eventId),
      orderBy: (anomalies, { desc }) => [desc(anomalies.timestamp)],
      limit: 50,
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            avatar: true,
            phone: true,
          }
        }
      }
    });

    return recentAnomalies.map(a => ({
      id: String(a.id),
      eventId: a.eventId,
      userId: a.userId,
      type: a.type,
      latitude: a.latitude,
      longitude: a.longitude,
      message: a.reason,
      timestamp: a.timestamp.toISOString(),
      name: a.user?.name,
    }));
  }

  async getEventParticipants(eventId: number) {
    const results = await this.db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        phone: schema.users.phone,
        healthInfo: schema.users.healthInfo,
        joinedAt: schema.eventParticipants.joinedAt,
        bibNumber: schema.eventParticipants.bibNumber,
      })
      .from(schema.eventParticipants)
      .innerJoin(
        schema.users,
        eq(schema.eventParticipants.userId, schema.users.id),
      )
      .where(eq(schema.eventParticipants.eventId, eventId));

    return { success: true, data: results };
  }

  async getPublicParticipants(eventId: number) {
    const results = await this.db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        joinedAt: schema.eventParticipants.joinedAt,
        bibNumber: schema.eventParticipants.bibNumber,
        state: schema.eventParticipants.participantState,
      })
      .from(schema.eventParticipants)
      .innerJoin(
        schema.users,
        eq(schema.eventParticipants.userId, schema.users.id),
      )
      .where(eq(schema.eventParticipants.eventId, eventId));

    return { success: true, data: results };
  }

  async joinEvent(user: any, eventId: number) {
    return this.db.transaction(async (tx) => {
      // 1. Find the event
      const event = await tx.query.events.findFirst({
        where: and(
          eq(schema.events.id, eventId),
          isNull(schema.events.deletedAt),
        ),
      });

      if (!event) {
        throw new NotFoundException('Event not found');
      }

      // Allow joining during IDLE or LIVE — tracking is gated by interlock screen
      if (event.status === 'FINISHED') {
        throw new ForbiddenException('Event has already finished');
      }

      // Check Registration Deadline
      if (event.registrationClose && new Date() > new Date(event.registrationClose)) {
        throw new ForbiddenException('Registration deadline has passed');
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

      // 4. Generate BIB Number
      const bibNumber = String(event.currentCount + 1).padStart(4, '0');

      // 5. Atomic Update
      await tx.insert(schema.eventParticipants).values({
        eventId: event.id,
        userId: user.id,
        bibNumber: bibNumber,
      });

      const [updatedEvent] = await tx
        .update(schema.events)
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
          bibNumber: bibNumber,
        },
      };
    });
  }

  async verifyBib(user: any, eventId: number, bibNumber: string) {
    return this.db.transaction(async (tx) => {
      // Find existing participant record for this user and event
      const participant = await tx.query.eventParticipants.findFirst({
        where: and(
          eq(schema.eventParticipants.eventId, eventId),
          eq(schema.eventParticipants.userId, user.id),
        ),
      });

      if (!participant) {
        throw new NotFoundException('Participant record not found. Please register first.');
      }

      if (participant.participantState === 'CONFIRMED' || participant.participantState === 'TRACKING') {
        return {
          success: true,
          message: 'BIB verified successfully. You are now ready to track.',
        };
      }

      // Check if BIB matches
      if (participant.bibNumber !== bibNumber) {
        throw new BadRequestException('Invalid BIB number for this event.');
      }

      // Update state to CONFIRMED
      await tx.update(schema.eventParticipants)
        .set({ participantState: 'CONFIRMED' })
        .where(eq(schema.eventParticipants.id, participant.id));

      return {
        success: true,
        message: 'BIB verified successfully. You are now ready to track.',
      };
    });
  }

  async joinEventViaToken(user: any, token: string) {
    return this.db.transaction(async (tx) => {
      // 1. Find the event
      const event = await tx.query.events.findFirst({
        where: and(
          eq(schema.events.token, token),
          isNull(schema.events.deletedAt),
        ),
      });

      if (!event) {
        throw new NotFoundException('Event not found or invalid token');
      }

      // Allow joining during IDLE or LIVE
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

      // 4. Generate BIB Number
      const bibNumber = String(event.currentCount + 1).padStart(4, '0');

      // 5. Atomic Update
      await tx.insert(schema.eventParticipants).values({
        eventId: event.id,
        userId: user.id,
        bibNumber: bibNumber,
      });

      const [updatedEvent] = await tx
        .update(schema.events)
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
          bibNumber: bibNumber,
        },
      };
    });
  }

  /**
   * Get raw event without auth checks — for internal use by MqttService / AnalysisService
   */
  async getEventRaw(eventId: number) {
    return this.db.query.events.findFirst({
      where: and(
        eq(schema.events.id, eventId),
        isNull(schema.events.deletedAt),
      ),
    });
  }

  async publicRegisterEvent(dto: any, eventId: number) {
    return this.db.transaction(async (tx) => {
      // 1. Find the event
      const event = await tx.query.events.findFirst({
        where: and(
          eq(schema.events.id, eventId),
          isNull(schema.events.deletedAt),
        ),
      });

      if (!event) {
        throw new NotFoundException('Event not found');
      }

      // 2. Validate Event State
      if (event.status !== 'IDLE' && event.status !== 'REGISTRATION_OPEN') {
        throw new ForbiddenException('Registration is not currently open for this event');
      }

      // 3. Validate Time
      if (event.registrationClose && new Date() > new Date(event.registrationClose)) {
        await tx.update(schema.events)
          .set({ status: 'REGISTRATION_CLOSED' })
          .where(eq(schema.events.id, event.id));
        throw new ForbiddenException('Registration has been closed because the deadline has passed');
      }

      // 4. Check Capacity
      if (event.currentCount >= event.maxParticipants) {
        await tx.update(schema.events)
          .set({ status: 'REGISTRATION_CLOSED' })
          .where(eq(schema.events.id, event.id));
        throw new ForbiddenException('Event has reached maximum capacity. Registration closed.');
      }

      // 5. Find or Create User
      let user = await tx.query.users.findFirst({
        where: eq(schema.users.email, dto.email),
      });

      if (!user) {
        const role = await tx.query.roles.findFirst({
          where: eq(schema.roles.name, 'PARTICIPANT'),
        });
        const roleId = role ? role.id : null;

        const hashedPassword = await bcrypt.hash(dto.password, 10);

        const [newUser] = await tx.insert(schema.users).values({
          email: dto.email,
          password: hashedPassword,
          name: dto.name,
          phone: dto.phone,
          roleId: roleId,
        }).returning();
        user = newUser;
      }

      // 6. Prevent Duplicates
      const existingParticipant = await tx.query.eventParticipants.findFirst({
        where: and(
          eq(schema.eventParticipants.eventId, event.id),
          eq(schema.eventParticipants.userId, user.id),
        ),
      });

      if (existingParticipant) {
        throw new ConflictException('You have already registered for this event');
      }

      // 7. Generate BIB Number
      const bibNumber = String(event.currentCount + 1).padStart(4, '0');

      // 8. Atomic Update
      await tx.insert(schema.eventParticipants).values({
        eventId: event.id,
        userId: user.id,
        bibNumber: bibNumber,
        participantState: 'REGISTERED',
      });

      await tx
        .update(schema.events)
        .set({ currentCount: event.currentCount + 1 })
        .where(eq(schema.events.id, event.id));

      return {
        success: true,
        data: {
          bibNumber,
          eventId: event.id,
          token: event.token, // Can be used for QR code
          message: 'Registration successful! Please save your BIB number and download the Dashly App.',
        },
      };
    });
  }



  async getParticipantTicket(userId: number, eventId: number) {
    const participantRows = await this.db
      .select({
        participant: schema.eventParticipants,
        event: schema.events,
      })
      .from(schema.eventParticipants)
      .innerJoin(schema.events, eq(schema.eventParticipants.eventId, schema.events.id))
      .where(
        and(
          eq(schema.eventParticipants.eventId, eventId),
          eq(schema.eventParticipants.userId, userId),
        )
      )
      .limit(1);

    if (!participantRows || participantRows.length === 0) {
      throw new NotFoundException('Registration record not found');
    }

    const { participant, event } = participantRows[0];

    const qrPayload = {
      participantId: participant.id,
      eventId: participant.eventId,
      userId: participant.userId,
      bibNumber: participant.bibNumber,
    };
    const signedToken = this.jwtService.sign(qrPayload);
    const qrCodeBase64 = await qrcode.toDataURL(signedToken);

    return {
      success: true,
      data: {
        participantNumber: participant.participantNumber,
        bibNumber: participant.bibNumber,
        qrCode: qrCodeBase64,
        eventName: event.name,
        dateEvent: event.dateEvent,
        location: event.locationName,
      },
    };
  }

  /**
   * Get all events that are currently active (status = LIVE).
   * Used for Redis rehydration on server restart.
   */
  async getActiveEvents() {
    return this.db.query.events.findMany({
      where: eq(schema.events.status, 'LIVE'),
    });
  }

  /**
   * Update a participant's state (e.g., unfreeze a FROZEN participant).
   * Only accessible by SUPER_ADMIN or STAFF.
   */
  async updateParticipantState(
    eventId: number,
    userId: number,
    newState: string,
  ) {
    const validStates = ['REGISTERED', 'CONFIRMED', 'TRACKING', 'FROZEN', 'FINISHED'];
    if (!validStates.includes(newState)) {
      throw new BadRequestException(
        `Invalid participant state. Must be one of: ${validStates.join(', ')}`,
      );
    }

    const participant = await this.db.query.eventParticipants.findFirst({
      where: and(
        eq(schema.eventParticipants.userId, userId),
        eq(schema.eventParticipants.eventId, eventId)
      ),
    });

    if (!participant) {
      throw new NotFoundException('Participant not found in this event');
    }

    const [updated] = await this.db
      .update(schema.eventParticipants)
      .set({ participantState: newState as any })
      .where(eq(schema.eventParticipants.id, participant.id))
      .returning();

    if (newState === 'TRACKING') {
      await this.db.delete(schema.anomalies)
        .where(
          and(
            eq(schema.anomalies.eventId, eventId),
            eq(schema.anomalies.userId, userId)
          )
        );
    }

    this.logger.log(
      `[Events] Participant (User ${userId}) state changed: ${participant.participantState} → ${newState}`,
    );

    return {
      success: true,
      data: updated,
      message: `Participant state updated to ${newState}`,
    };
  }

  async deleteAnomaly(eventId: number, anomalyId: number) {
    const [deleted] = await this.db.delete(schema.anomalies)
      .where(
        and(
          eq(schema.anomalies.id, anomalyId),
          eq(schema.anomalies.eventId, eventId)
        )
      )
      .returning();
      
    if (!deleted) {
      throw new NotFoundException('Anomaly not found');
    }
    
    return { success: true, data: deleted };
  }

  async deleteAnomalyByType(eventId: number, userId: number, type: string) {
    const [deleted] = await this.db.delete(schema.anomalies)
      .where(
        and(
          eq(schema.anomalies.userId, userId),
          eq(schema.anomalies.eventId, eventId),
          eq(schema.anomalies.type, type)
        )
      )
      .returning();
      
    return { success: true, data: deleted };
  }

  async getMyLiveStats(eventId: number, user: any) {
    const userId = user.id || user.sub;

    const participant = await this.db.query.eventParticipants.findFirst({
      where: and(
        eq(schema.eventParticipants.eventId, eventId),
        eq(schema.eventParticipants.userId, userId),
      ),
    });

    if (!participant) {
      throw new NotFoundException('Not joined');
    }

    const allRankings = await this.redisService.getAllRankings(eventId);
    let rank: number | null = allRankings.findIndex((r) => r.participantId === participant.id) + 1;
    if (rank === 0) rank = null;

    const progress = await this.redisService.getProgressState(eventId, participant.id);

    return {
      success: true,
      data: {
        rank,
        progressPercentage: progress?.progressPercentage ?? 0,
        distanceCovered: progress?.distanceCovered ?? 0,
        checkpointsCompleted: progress?.checkpointsCompleted ?? 0,
        participantState: participant.participantState,
      }
    };
  }
}
