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
import { eq, and, isNull, lt, sql, asc } from 'drizzle-orm';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { UpdateEventStatusDto } from './dto/update-event-status.dto';
import { FinishParticipantDto } from './dto/finish-participant.dto';
import { getMonitoringWindow } from './monitoring.helper';
import { RedisService } from '../redis/redis.service';
import { OsrmService } from './osrm.service';
import { JwtService } from '@nestjs/jwt';
import * as qrcode from 'qrcode';
import * as bcrypt from 'bcrypt';
import * as ExcelJS from 'exceljs';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    private readonly redisService: RedisService,
    private readonly jwtService: JwtService,
    private readonly osrmService: OsrmService,
  ) {}

  async getEventPositions(eventId: number) {
    return this.redisService.getAllParticipantPositions(eventId);
  }

  /**
   * Get live positions from Redis, enriched with participant names from DB.
   * Used by dashboard on initial load / refresh to restore markers instantly.
   */
  async getLivePositions(eventId: number) {
    const [positions, rankings] = await Promise.all([
      this.redisService.getAllParticipantPositions(eventId),
      this.redisService.getAllRankings(eventId),
    ]);

    // Build ranking lookup: participantId → { rank (1-based), score }
    const rankMap = new Map<number, { rank: number; score: number }>();
    rankings.forEach((r, idx) => {
      rankMap.set(r.participantId, { rank: idx + 1, score: r.score });
    });

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
      .innerJoin(schema.users, eq(schema.eventParticipants.userId, schema.users.id))
      .where(eq(schema.eventParticipants.eventId, eventId));

    const infoMap = new Map(participantRows.map((p) => [p.participantId, p]));

    return positions.map((p) => {
      const info = infoMap.get(p.participantId);
      const rankInfo = rankMap.get(p.participantId);
      return {
        ...p,
        userId: info?.userId || p.userId,
        isOffline: p.isOffline === 'true' || p.isOffline === true,
        name: info?.name || `Runner ${info?.userId || p.userId}`,
        state: info?.state || 'TRACKING',
        bibNumber: info?.bibNumber || '-',
        rank: rankInfo?.rank ?? null,
        score: rankInfo?.score ?? null,
        progressPercent: p.routeDistance != null && p.routeDistance !== '' ? null : null,
      };
    });
  }

  async getEventPathHistory(eventId: number) {
    const logs = await this.db
      .select({
        userId: schema.locationLogs.userId,
        latitude: schema.locationLogs.latitude,
        longitude: schema.locationLogs.longitude,
      })
      .from(schema.locationLogs)
      .where(eq(schema.locationLogs.eventId, eventId))
      .orderBy(schema.locationLogs.capturedAt);

    return logs.reduce<Record<number, number[][]>>((history, log) => {
      (history[log.userId] ??= []).push([log.longitude, log.latitude]);
      return history;
    }, {});
  }

  async getEventAnomalies(eventId: number) {
    const anomalyRows = await this.db
      .select({
        id: schema.anomalies.id,
        eventId: schema.anomalies.eventId,
        userId: schema.anomalies.userId,
        type: schema.anomalies.type,
        latitude: schema.anomalies.latitude,
        longitude: schema.anomalies.longitude,
        reason: schema.anomalies.reason,
        timestamp: schema.anomalies.timestamp,
        name: schema.users.name,
        bibNumber: schema.eventParticipants.bibNumber,
      })
      .from(schema.anomalies)
      .leftJoin(schema.users, eq(schema.anomalies.userId, schema.users.id))
      .leftJoin(
        schema.eventParticipants,
        and(
          eq(schema.eventParticipants.eventId, eventId),
          eq(schema.eventParticipants.userId, schema.anomalies.userId),
        ),
      )
      .where(eq(schema.anomalies.eventId, eventId))
      .orderBy(asc(schema.anomalies.timestamp));

    return anomalyRows.map((a) => ({
      id: `db-anomaly-${a.id}`,
      eventId: a.eventId,
      userId: String(a.userId),
      participantId: String(a.userId),
      type: a.type,
      lat: a.latitude,
      lng: a.longitude,
      reason: a.reason,
      message: a.reason,
      timestamp: a.timestamp ? new Date(a.timestamp).toISOString() : new Date().toISOString(),
      name: a.name || `Runner ${a.userId}`,
      bibNumber: a.bibNumber || '-',
      severity: a.type === 'SOS_EMERGENCY' ? 'HIGH' : 'MEDIUM',
    }));
  }

  async createEvent(user: any, dto: CreateEventDto) {
    const category = (dto.category as 'RUNNING' | 'CYCLING') || 'RUNNING';
    const normalizedRoute = dto.routeGeojson
      ? await this.osrmService.normalizeRoute(category, dto.routeGeojson)
      : null;

    return this.db.transaction(async (tx) => {
      // 1. Generate unique 6-char alphanumeric code
      const tokenCode = Math.random().toString(36).substring(2, 8).toUpperCase();

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
          totalDistanceMeters: normalizedRoute?.totalDistanceMeters ?? dto.totalDistanceMeters,
          totalElevationMeters: normalizedRoute?.totalElevationMeters ?? dto.totalElevationMeters,
          altitudeProfile: normalizedRoute?.altitudeProfile,
          startTime: new Date(dto.startTime),
          endTime: new Date(dto.endTime),
          registrationOpen: dto.registrationOpen ? new Date(dto.registrationOpen) : null,
          registrationClose: dto.registrationClose ? new Date(dto.registrationClose) : null,
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
      where: and(eq(schema.events.id, eventId), isNull(schema.events.deletedAt)),
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
        altitudeProfile: true,
        totalElevationMeters: true,
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
        altitudeProfile: event.altitudeProfile,
        totalElevationMeters: event.totalElevationMeters,
      },
    };
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
      const eventIds = staffLinks
        .map((link) => link.eventId)
        .filter((id): id is number => id !== null);

      if (eventIds.length === 0) return { success: true, data: [] };

      events = await this.db.query.events.findMany({
        where: (events, { inArray, and }) => and(inArray(events.id, eventIds), baseWhere),
      });
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
    const events = await this.db.query.events.findMany({
      where: baseWhere,
      columns: {
        routeGeojson: false,
      },
    });

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
        bannerImage: schema.events.bannerImage,
        startTime: schema.events.startTime,
        endTime: schema.events.endTime,
        monitoringStartOffset: schema.events.monitoringStartOffset,
        monitoringEndOffset: schema.events.monitoringEndOffset,
        // Route info fields (from events table)
        routeGeojson: schema.events.routeGeojson,
        totalDistanceMeters: schema.events.totalDistanceMeters,
        totalElevationMeters: schema.events.totalElevationMeters,
        altitudeProfile: schema.events.altitudeProfile,
        latitude: schema.events.latitude,
        longitude: schema.events.longitude,
        // Participant-specific fields
        participantState: schema.eventParticipants.participantState,
        bibNumber: schema.eventParticipants.bibNumber,
        durationSeconds: schema.eventParticipants.durationSeconds,
        participantDistanceMeters: schema.eventParticipants.totalDistanceMeters,
        avgSpeedKmh: schema.eventParticipants.avgSpeedKmh,
        maxSpeedKmh: schema.eventParticipants.maxSpeedKmh,
        elevationGainMeters: schema.eventParticipants.elevationGainMeters,
        finishedAt: schema.eventParticipants.finishedAt,
      })
      .from(schema.events)
      .innerJoin(schema.eventParticipants, eq(schema.events.id, schema.eventParticipants.eventId))
      .where(and(eq(schema.eventParticipants.userId, user.id), isNull(schema.events.deletedAt)));

    const enriched = joinedEvents.map((event) => ({
      ...event,
      monitoringWindow: getMonitoringWindow(event as any),
      bibNumber: event.bibNumber,
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
        where: and(eq(schema.eventStaff.eventId, eventId), eq(schema.eventStaff.userId, user.id)),
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
        throw new BadRequestException('Cannot finish event: event must be in LIVE status first.');
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
    if (dto.maxParticipants !== undefined) updateData.maxParticipants = dto.maxParticipants;
    if (dto.dateEvent !== undefined) updateData.dateEvent = new Date(dto.dateEvent);
    if (dto.routeGeojson !== undefined) {
      const category = (dto.category ?? existing.data.category) as 'RUNNING' | 'CYCLING';
      const normalizedRoute = await this.osrmService.normalizeRoute(category, dto.routeGeojson);
      updateData.routeGeojson = normalizedRoute?.geoJson ?? dto.routeGeojson;
      if (normalizedRoute) {
        updateData.totalDistanceMeters = normalizedRoute.totalDistanceMeters;
        if (normalizedRoute.altitudeProfile) {
          updateData.altitudeProfile = normalizedRoute.altitudeProfile;
        }
        if (normalizedRoute.totalElevationMeters !== undefined) {
          updateData.totalElevationMeters = normalizedRoute.totalElevationMeters;
        }
      }
    }
    if (dto.category !== undefined) updateData.category = dto.category;
    if (dto.startTime !== undefined) updateData.startTime = new Date(dto.startTime);
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
      updateData.registrationOpen = dto.registrationOpen ? new Date(dto.registrationOpen) : null;
    if (dto.registrationClose !== undefined)
      updateData.registrationClose = dto.registrationClose ? new Date(dto.registrationClose) : null;
    if (dto.locationName !== undefined) updateData.locationName = dto.locationName;
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

  async getParticipants(eventId: number) {
    const results = await this.db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        phone: schema.users.phone,
        healthInfo: schema.users.healthInfo,
        healthProfile: {
          bloodType: schema.userHealthProfiles.bloodType,
          weight: schema.userHealthProfiles.weight,
          height: schema.userHealthProfiles.height,
          emergencyName: schema.userHealthProfiles.emergencyName,
          emergencyPhone: schema.userHealthProfiles.emergencyPhone,
          emergencyRelation: schema.userHealthProfiles.emergencyRelation,
          emergencyContact: schema.userHealthProfiles.emergencyContact,
          medicalHistory: schema.userHealthProfiles.medicalHistory,
        },
        joinedAt: schema.eventParticipants.joinedAt,
        bibNumber: schema.eventParticipants.bibNumber,
      })
      .from(schema.eventParticipants)
      .innerJoin(schema.users, eq(schema.eventParticipants.userId, schema.users.id))
      .leftJoin(schema.userHealthProfiles, eq(schema.users.id, schema.userHealthProfiles.userId))
      .where(eq(schema.eventParticipants.eventId, eventId));

    const formatted = results.map((r) => {
      const mergedHealth =
        r.healthProfile?.bloodType || r.healthProfile?.emergencyContact
          ? {
              bloodType: r.healthProfile.bloodType,
              weight: r.healthProfile.weight,
              height: r.healthProfile.height,
              emergencyName: r.healthProfile.emergencyName,
              emergencyPhone: r.healthProfile.emergencyPhone,
              emergencyRelation: r.healthProfile.emergencyRelation,
              emergencyContact: r.healthProfile.emergencyContact,
              medicalHistory: r.healthProfile.medicalHistory,
            }
          : r.healthInfo;

      return {
        ...r,
        healthInfo: mergedHealth,
        healthProfile: r.healthProfile,
      };
    });

    return { success: true, data: formatted };
  }

  private async reserveParticipant(
    tx: Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0],
    event: typeof schema.events.$inferSelect,
    userId: number,
    participantState?: 'REGISTERED',
  ) {
    const existingParticipant = await tx.query.eventParticipants.findFirst({
      where: and(
        eq(schema.eventParticipants.eventId, event.id),
        eq(schema.eventParticipants.userId, userId),
      ),
    });
    if (existingParticipant) {
      throw new ConflictException('You have already joined this event');
    }

    const [updatedEvent] = await tx
      .update(schema.events)
      .set({ currentCount: sql`${schema.events.currentCount} + 1` })
      .where(
        and(
          eq(schema.events.id, event.id),
          lt(schema.events.currentCount, schema.events.maxParticipants),
        ),
      )
      .returning();
    if (!updatedEvent) {
      throw new ForbiddenException('Event has reached maximum capacity');
    }

    const bibNumber = String(updatedEvent.currentCount).padStart(4, '0');
    await tx.insert(schema.eventParticipants).values({
      eventId: event.id,
      userId,
      bibNumber,
      ...(participantState ? { participantState } : {}),
    });
    return { updatedEvent, bibNumber };
  }

  async getPublicParticipants(eventId: number) {
    const participants = await this.db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        joinedAt: schema.eventParticipants.joinedAt,
        bibNumber: schema.eventParticipants.bibNumber,
        state: schema.eventParticipants.participantState,
      })
      .from(schema.eventParticipants)
      .innerJoin(schema.users, eq(schema.eventParticipants.userId, schema.users.id))
      .where(eq(schema.eventParticipants.eventId, eventId));

    return { success: true, data: participants };
  }

  async joinEvent(user: any, eventId: number) {
    return this.db.transaction(async (tx) => {
      // 1. Find the event
      const event = await tx.query.events.findFirst({
        where: and(eq(schema.events.id, eventId), isNull(schema.events.deletedAt)),
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

      const { updatedEvent, bibNumber } = await this.reserveParticipant(tx, event, user.id);

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

      if (
        participant.participantState === 'CONFIRMED' ||
        participant.participantState === 'TRACKING'
      ) {
        throw new ConflictException('Your BIB is already verified.');
      }

      // Check if BIB matches
      if (participant.bibNumber !== bibNumber) {
        throw new BadRequestException('Invalid BIB number for this event.');
      }

      // Update state to CONFIRMED
      await tx
        .update(schema.eventParticipants)
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
        where: and(eq(schema.events.token, token), isNull(schema.events.deletedAt)),
      });

      if (!event) {
        throw new NotFoundException('Event not found or invalid token');
      }

      // Allow joining during IDLE or LIVE
      if (event.status === 'FINISHED') {
        throw new ForbiddenException('Event has already finished');
      }

      const { updatedEvent, bibNumber } = await this.reserveParticipant(tx, event, user.id);

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
      where: and(eq(schema.events.id, eventId), isNull(schema.events.deletedAt)),
    });
  }

  async publicRegisterEvent(dto: any, eventId: number) {
    return this.db.transaction(async (tx) => {
      // 1. Find the event
      const event = await tx.query.events.findFirst({
        where: and(eq(schema.events.id, eventId), isNull(schema.events.deletedAt)),
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
        await tx
          .update(schema.events)
          .set({ status: 'REGISTRATION_CLOSED' })
          .where(eq(schema.events.id, event.id));
        throw new ForbiddenException(
          'Registration has been closed because the deadline has passed',
        );
      }

      // 4. Find or Create User
      let user = await tx.query.users.findFirst({
        where: eq(schema.users.email, dto.email),
      });

      if (!user) {
        const role = await tx.query.roles.findFirst({
          where: eq(schema.roles.name, 'PARTICIPANT'),
        });
        const roleId = role ? role.id : null;

        const hashedPassword = await bcrypt.hash(dto.password, 10);

        const [newUser] = await tx
          .insert(schema.users)
          .values({
            email: dto.email,
            password: hashedPassword,
            name: dto.name,
            phone: dto.phone,
            roleId: roleId,
          })
          .returning();
        user = newUser;
      }

      const { bibNumber } = await this.reserveParticipant(tx, event, user.id, 'REGISTERED');

      return {
        success: true,
        data: {
          bibNumber,
          eventId: event.id,
          token: event.token, // Can be used for QR code
          message:
            'Registration successful! Please save your BIB number and download the Dashly App.',
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
        ),
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
  async updateParticipantState(eventId: number, userId: number, newState: string) {
    const validStates = ['REGISTERED', 'CONFIRMED', 'TRACKING', 'FROZEN', 'FINISHED'];
    if (!validStates.includes(newState)) {
      throw new BadRequestException(
        `Invalid participant state. Must be one of: ${validStates.join(', ')}`,
      );
    }

    const participant = await this.db.query.eventParticipants.findFirst({
      where: and(
        eq(schema.eventParticipants.userId, userId),
        eq(schema.eventParticipants.eventId, eventId),
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

    this.logger.log(
      `[Events] Participant (User ${userId}) state changed: ${participant.participantState} → ${newState}`,
    );

    await this.redisService.setParticipantStateOnly(eventId, participant.id, newState);

    if (newState === 'TRACKING') {
      // Automatically clear any persisted anomaly records when unfreezing participant
      await this.db
        .delete(schema.anomalies)
        .where(and(eq(schema.anomalies.userId, userId), eq(schema.anomalies.eventId, eventId)));
    }

    return {
      success: true,
      data: updated,
      message: `Participant state updated to ${newState}`,
    };
  }

  async finishParticipant(eventId: number, userId: number, dto?: FinishParticipantDto) {
    const participant = await this.db.query.eventParticipants.findFirst({
      where: and(
        eq(schema.eventParticipants.eventId, eventId),
        eq(schema.eventParticipants.userId, userId),
      ),
    });

    if (!participant) {
      throw new NotFoundException('Participant not found in this event');
    }

    const updatePayload: Record<string, any> = {
      participantState: 'FINISHED',
      finishedAt: new Date(),
    };

    if (dto?.durationSeconds != null) updatePayload.durationSeconds = dto.durationSeconds;
    if (dto?.totalDistanceMeters != null)
      updatePayload.totalDistanceMeters = dto.totalDistanceMeters;
    if (dto?.avgSpeedKmh != null) updatePayload.avgSpeedKmh = dto.avgSpeedKmh;
    if (dto?.maxSpeedKmh != null) updatePayload.maxSpeedKmh = dto.maxSpeedKmh;
    if (dto?.elevationGainMeters != null)
      updatePayload.elevationGainMeters = dto.elevationGainMeters;

    const [updated] = await this.db
      .update(schema.eventParticipants)
      .set(updatePayload)
      .where(eq(schema.eventParticipants.id, participant.id))
      .returning();

    await this.redisService.setParticipantStateOnly(eventId, participant.id, 'FINISHED');

    return {
      success: true,
      data: updated,
      message: 'Participant ride marked as FINISHED',
    };
  }

  async deleteAnomaly(eventId: number, anomalyId: number) {
    const [deleted] = await this.db
      .delete(schema.anomalies)
      .where(and(eq(schema.anomalies.id, anomalyId), eq(schema.anomalies.eventId, eventId)))
      .returning();

    if (!deleted) {
      throw new NotFoundException('Anomaly not found');
    }

    return { success: true, data: deleted };
  }

  async deleteAnomaliesByUserId(eventId: number, userId: number) {
    const deleted = await this.db
      .delete(schema.anomalies)
      .where(and(eq(schema.anomalies.userId, userId), eq(schema.anomalies.eventId, eventId)))
      .returning();

    return { success: true, count: deleted.length };
  }

  async deleteAnomalyByType(eventId: number, userId: number, type: string) {
    const [deleted] = await this.db
      .delete(schema.anomalies)
      .where(
        and(
          eq(schema.anomalies.userId, userId),
          eq(schema.anomalies.eventId, eventId),
          eq(schema.anomalies.type, type),
        ),
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
      },
    };
  }

  async generateTelemetryReport(eventId: number): Promise<Buffer> {
    const event = await this.db.query.events.findFirst({
      where: and(eq(schema.events.id, eventId), isNull(schema.events.deletedAt)),
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const participants = await this.db.query.eventParticipants.findMany({
      where: eq(schema.eventParticipants.eventId, eventId),
      with: {
        user: true,
      },
    });

    const logs = await this.db.query.locationLogs.findMany({
      where: eq(schema.locationLogs.eventId, eventId),
      orderBy: asc(schema.locationLogs.capturedAt),
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Dashly System';
    workbook.created = new Date();

    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [
      { header: 'BIB', key: 'bib', width: 10 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Role', key: 'role', width: 15 },
      { header: 'Total Pings', key: 'totalPings', width: 15 },
      { header: 'Start Time', key: 'startTime', width: 25 },
      { header: 'End Time', key: 'endTime', width: 25 },
      { header: 'Avg Latency (ms)', key: 'avgLatency', width: 20 },
      { header: 'Max Latency (ms)', key: 'maxLatency', width: 20 },
      { header: 'Start Battery (%)', key: 'startBattery', width: 20 },
      { header: 'End Battery (%)', key: 'endBattery', width: 20 },
      { header: 'Battery Drain (%)', key: 'batteryDrain', width: 20 },
    ];

    const rawSheet = workbook.addWorksheet('Raw Data');
    rawSheet.columns = [
      { header: 'BIB', key: 'bib', width: 10 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Captured At', key: 'capturedAt', width: 25 },
      { header: 'Server Received At', key: 'serverReceivedAt', width: 25 },
      { header: 'Latency (ms)', key: 'latency', width: 15 },
      { header: 'Battery (%)', key: 'battery', width: 15 },
      { header: 'Speed (m/s)', key: 'speed', width: 15 },
      { header: 'Is Anomaly', key: 'isAnomaly', width: 15 },
      { header: 'Is Offline', key: 'isOffline', width: 15 },
    ];

    const participantMap = new Map();
    for (const p of participants) {
      participantMap.set(p.id, {
        bib: p.bibNumber,
        name: (p as any).user?.name || 'Unknown',
        role: 'Participant',
        totalPings: 0,
        startTime: null,
        endTime: null,
        latencies: [],
        startBattery: null,
        endBattery: null,
      });
    }

    for (const log of logs) {
      if (!log.participantId) continue;

      const pStats = participantMap.get(log.participantId);
      if (!pStats) continue;

      const capturedAt = new Date(log.capturedAt);
      const serverReceivedAt = new Date(log.serverReceivedAt);

      const latencyMs = Math.max(0, serverReceivedAt.getTime() - capturedAt.getTime());

      rawSheet.addRow({
        bib: pStats.bib,
        name: pStats.name,
        capturedAt: capturedAt.toISOString(),
        serverReceivedAt: serverReceivedAt.toISOString(),
        latency: latencyMs,
        battery: log.battery ?? '-',
        speed: log.speed ?? '-',
        isAnomaly: log.isAnomaly ? 'Yes' : 'No',
        isOffline: log.isOffline ? 'Yes' : 'No',
      });

      pStats.totalPings++;
      pStats.latencies.push(latencyMs);

      if (!pStats.startTime) pStats.startTime = capturedAt;
      pStats.endTime = capturedAt;

      if (log.battery != null) {
        if (pStats.startBattery == null) pStats.startBattery = log.battery;
        pStats.endBattery = log.battery;
      }
    }

    for (const pStats of participantMap.values()) {
      if (pStats.totalPings === 0) continue;

      const avgLatency =
        pStats.latencies.reduce((a: number, b: number) => a + b, 0) / pStats.latencies.length;
      const maxLatency = Math.max(...pStats.latencies);
      const batteryDrain =
        pStats.startBattery != null && pStats.endBattery != null
          ? pStats.startBattery - pStats.endBattery
          : null;

      summarySheet.addRow({
        bib: pStats.bib,
        name: pStats.name,
        role: pStats.role,
        totalPings: pStats.totalPings,
        startTime: pStats.startTime ? pStats.startTime.toISOString() : '-',
        endTime: pStats.endTime ? pStats.endTime.toISOString() : '-',
        avgLatency: Math.round(avgLatency),
        maxLatency: maxLatency,
        startBattery: pStats.startBattery ?? '-',
        endBattery: pStats.endBattery ?? '-',
        batteryDrain: batteryDrain ?? '-',
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer as unknown as Buffer;
  }

  /**
   * Helper to parse CSV buffer into array of objects handling quoted string fields safely,
   * auto-detecting delimiters (comma, semicolon, tab), and stripping UTF-8 BOM.
   */
  private parseCsvBuffer(buffer: Buffer): Record<string, string>[] {
    let content = buffer.toString('utf-8');
    // Remove UTF-8/UTF-16 BOM and NULL bytes if present
    content = content
      .replaceAll(String.fromCharCode(0), '')
      .replace(/[\uFEFF\u200B]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];

    // Auto-detect delimiter from header line (comma, semicolon, or tab)
    const line0 = lines[0];
    const commaCount = (line0.match(/,/g) || []).length;
    const semiCount = (line0.match(/;/g) || []).length;
    const tabCount = (line0.match(/\t/g) || []).length;
    let delimiter = ',';
    if (semiCount > commaCount && semiCount >= tabCount) delimiter = ';';
    else if (tabCount > commaCount && tabCount > semiCount) delimiter = '\t';

    const parseLine = (line: string, delim: string): string[] => {
      const result: string[] = [];
      let current = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === delim && !inQuotes) {
          result.push(current.trim().replace(/^["']|["']$/g, ''));
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim().replace(/^["']|["']$/g, ''));

      // Fallback regex split if delimiter loop failed to split columns
      if (result.length <= 1 && delim === ',') {
        const regexSplit = line
          .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
          .map((item) => item.trim().replace(/^["']|["']$/g, ''));
        if (regexSplit.length > 1) return regexSplit;
      }
      return result;
    };

    const headers = parseLine(lines[0], delimiter).map((h) =>
      h
        .replace(/^["']|["']$/g, '')
        .replace(/[\uFEFF\u200B]/g, '')
        .trim()
        .toLowerCase(),
    );
    const records: Record<string, string>[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseLine(lines[i], delimiter);
      if (values.length === 0 || (values.length === 1 && !values[0])) continue;

      const record: Record<string, string> = {};
      headers.forEach((header, idx) => {
        let val = values[idx] || '';
        val = val.replace(/^["']|["']$/g, '').trim();
        record[header] = val;
      });
      records.push(record);
    }

    return records;
  }

  async importParticipantsFromJson(eventId: number, participants: Record<string, any>[]) {
    const event = await this.db.query.events.findFirst({
      where: eq(schema.events.id, eventId),
    });
    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }
    if (!participants || participants.length === 0) {
      throw new BadRequestException('Participants data is empty');
    }
    return this.processImportRows(eventId, participants);
  }

  async importParticipantsFromCsv(eventId: number, fileBuffer: Buffer) {
    const event = await this.db.query.events.findFirst({
      where: eq(schema.events.id, eventId),
    });
    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }

    const records = this.parseCsvBuffer(fileBuffer);
    if (records.length === 0) {
      throw new BadRequestException('CSV file is empty or invalid format');
    }

    return this.processImportRows(eventId, records);
  }

  private async processImportRows(eventId: number, records: Record<string, any>[]) {
    let successCount = 0;
    let createdUsersCount = 0;
    let existingUsersCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const getVal = (...keys: string[]) => {
        for (const k of keys) {
          const target = k.toLowerCase().replace(/[^a-z0-9]/g, '');
          for (const rawKey of Object.keys(row)) {
            const normalizedKey = rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (normalizedKey === target && row[rawKey] !== undefined && row[rawKey] !== null) {
              return String(row[rawKey]).trim();
            }
          }
        }
        return '';
      };

      let rawEmail = getVal('email', 'email address', 'mail', 'alamat email', 'e-mail');
      let name = getVal('fullname', 'full name', 'nama lengkap', 'nama', 'name');
      let phone = getVal(
        'phone',
        'nomor hp',
        'telepon',
        'handphone',
        'no hp',
        'phone number',
        'nohp',
      );
      let bibNum = getVal(
        'participantnumber',
        'participant number',
        'bib number',
        'bibnumber',
        'bib',
        'no bib',
        'nomor peserta',
      );
      const bloodType = getVal('bloodtype', 'golongan darah', 'blood type', 'goldar');
      const medicalHistory = getVal(
        'medicalhistory',
        'penyakit bawaan',
        'medical history',
        'riwayat penyakit',
      );
      const emergencyPhone = getVal(
        'emergencyphone',
        'nomor kontak darurat',
        'emergency phone',
        'kontak darurat',
        'emergency contact',
      );
      const emergencyRelation = getVal(
        'emergencyrelation',
        'hubungan dengan kontak darurat',
        'emergency relation',
        'hubungan kontak darurat',
        'hubungan',
      );

      // Pattern-based and Column Index Fallbacks if header matching failed
      const allRowValues = Object.values(row).map((v) => String(v ?? '').trim());

      // 1. Email Fallback: Find any cell matching email regex or column index 3
      if (!rawEmail) {
        const emailCell = allRowValues.find((v) => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(v));
        if (emailCell) {
          rawEmail = emailCell;
        } else if (allRowValues[3] && allRowValues[3].includes('@')) {
          rawEmail = allRowValues[3];
        }
      }

      // 2. Phone Fallback: Find any cell with phone pattern or column index 4
      if (!phone) {
        const phoneCell = allRowValues.find((v) =>
          /^\+?[0-9]{8,15}$/.test(v.replace(/[\s-]/g, '')),
        );
        if (phoneCell) {
          phone = phoneCell;
        } else if (allRowValues[4]) {
          phone = allRowValues[4];
        }
      }

      // 3. Name Fallback: Column index 2 or first text cell that is not email/phone
      if (!name || name === 'Participant') {
        if (
          allRowValues[2] &&
          !allRowValues[2].includes('@') &&
          !/^\+?[0-9]{8,15}$/.test(allRowValues[2])
        ) {
          name = allRowValues[2].replace(/^["']|["']$/g, '');
        }
      }

      // 4. BIB Fallback: Column index 0 or formatted index
      if (!bibNum || bibNum === String(i + 1).padStart(3, '0')) {
        if (allRowValues[0] && allRowValues[0] !== name) {
          bibNum = allRowValues[0].replace(/^["']|["']$/g, '');
        } else {
          bibNum = String(i + 1).padStart(3, '0');
        }
      }

      const email = rawEmail ? rawEmail.toLowerCase().trim() : '';

      if (!email) {
        errors.push(`Row ${i + 1}: Email is missing for ${name || 'Participant'}`);
        continue;
      }

      try {
        await this.db.transaction(async (tx) => {
          // 1. Check or create User
          let user = await tx.query.users.findFirst({
            where: eq(schema.users.email, email),
          });

          let userId: number;
          if (!user) {
            const rawPassword = phone ? phone.trim() : 'EcoRace2026!';
            const hashedPassword = await bcrypt.hash(rawPassword, 10);
            const [newUser] = await tx
              .insert(schema.users)
              .values({
                email,
                name,
                phone: phone || null,
                password: hashedPassword,
              })
              .returning();
            userId = newUser.id;
            createdUsersCount++;
          } else {
            userId = user.id;
            existingUsersCount++;
            if (phone || name) {
              await tx
                .update(schema.users)
                .set({
                  ...(phone && !user.phone ? { phone } : {}),
                  ...(name && user.name === 'User' ? { name } : {}),
                })
                .where(eq(schema.users.id, userId));
            }
          }

          // 2. Upsert Health Profile
          if (bloodType || emergencyPhone || medicalHistory || emergencyRelation) {
            const existingHealth = await tx.query.userHealthProfiles.findFirst({
              where: eq(schema.userHealthProfiles.userId, userId),
            });

            if (existingHealth) {
              await tx
                .update(schema.userHealthProfiles)
                .set({
                  ...(bloodType ? { bloodType } : {}),
                  ...(medicalHistory ? { medicalHistory } : {}),
                  ...(emergencyPhone ? { emergencyPhone, emergencyContact: emergencyPhone } : {}),
                  ...(emergencyRelation ? { emergencyRelation } : {}),
                  updatedAt: new Date(),
                })
                .where(eq(schema.userHealthProfiles.userId, userId));
            } else {
              await tx.insert(schema.userHealthProfiles).values({
                userId,
                bloodType: bloodType || null,
                medicalHistory: medicalHistory || null,
                emergencyPhone: emergencyPhone || null,
                emergencyContact: emergencyPhone || null,
                emergencyRelation: emergencyRelation || null,
              });
            }
          }

          // 3. Register or Update Event Participant
          const existingParticipant = await tx.query.eventParticipants.findFirst({
            where: and(
              eq(schema.eventParticipants.eventId, eventId),
              eq(schema.eventParticipants.userId, userId),
            ),
          });

          if (!existingParticipant) {
            await tx.insert(schema.eventParticipants).values({
              eventId,
              userId,
              participantNumber: bibNum,
              bibNumber: bibNum,
              participantState: 'CONFIRMED',
            });

            await tx
              .update(schema.events)
              .set({ currentCount: sql`${schema.events.currentCount} + 1` })
              .where(eq(schema.events.id, eventId));
          } else {
            await tx
              .update(schema.eventParticipants)
              .set({
                bibNumber: bibNum,
                participantNumber: bibNum,
                participantState: 'CONFIRMED',
              })
              .where(eq(schema.eventParticipants.id, existingParticipant.id));
          }

          successCount++;
        });
      } catch (err: any) {
        this.logger.error(`Error importing row ${i + 1} (${email}): ${err.message}`, err.stack);
        errors.push(`Row ${i + 1} (${email}): ${err.message}`);
      }
    }

    return {
      success: true,
      message: `Successfully imported ${successCount} participants.`,
      stats: {
        totalRows: records.length,
        successCount,
        createdUsersCount,
        existingUsersCount,
        errorCount: errors.length,
      },
      errors,
    };
  }
}
