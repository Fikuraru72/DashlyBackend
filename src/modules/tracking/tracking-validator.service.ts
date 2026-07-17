import { Injectable, Logger } from '@nestjs/common';
import { IdentityCacheService } from './identity-cache.service';
import { EventCacheService } from './event-cache.service';
import { TrackingStreamService } from '../stream/tracking-stream.service';
import {
  TrackingEvent,
  RawIngestPayload,
} from '../common/interfaces/tracking-event.interface';

/**
 * TrackingValidatorService — LIGHTWEIGHT normaliser.
 *
 * Responsibilities:
 *   1. Resolve participantId → userId (via IdentityCacheService)
 *   2. Verify event is in LIVE status (via EventCacheService)
 *   3. Type coercion (parseFloat, Date)
 *   4. Construct TrackingEvent with EMPTY flags
 *   5. Publish to tracking-events-raw queue
 *
 * ⚠️  This service does NOT:
 *   - Calculate haversine or speed
 *   - Filter noise or detect anomalies
 *   - Access the database directly
 *   - Emit WebSocket events
 */
@Injectable()
export class TrackingValidatorService {
  private readonly logger = new Logger(TrackingValidatorService.name);

  constructor(
    private readonly eventCache: EventCacheService,
    private readonly stream: TrackingStreamService,
  ) {}

  /**
   * Process a single location payload from the MQTT ingest layer.
   * Returns true if the event was published to the raw queue, false if dropped.
   */
  async processLocation(raw: RawIngestPayload): Promise<boolean> {
    // 1. Check event status
    const eventStatus = await this.eventCache.getEventStatus(raw.eventId);
    if (eventStatus !== 'LIVE') {
      this.logger.debug(
        `[Validator] Dropping: event ${raw.eventId} status is '${eventStatus || 'NOT_FOUND'}'`,
      );
      return false;
    }

    // 2. Normalise into TrackingEvent
    const event = this.normalise(raw);

    // 3. Publish to raw queue
    await this.stream.publishRaw(event);
    return true;
  }

  /**
   * Process an offline sync batch (array of raw payloads).
   */
  async processSyncBatch(
    eventId: number,
    participantId: number,
    userId: number,
    points: any[],
  ): Promise<void> {
    for (const p of points) {
      const raw: RawIngestPayload = {
        eventId,
        participantId,
        userId,
        msgId: p.msg_id,
        lat: p.lat,
        lng: p.lng,
        speed: p.speed || 0,
        battery: p.battery != null && !isNaN(parseInt(p.battery as string)) ? parseInt(p.battery as string) : undefined,
        capturedAt: p.captured_at || null,
        status: 'sync',
      };

      const event = this.normalise(raw);
      event.flags.isOffline = true;
      event.gatekeeperAction = 'SYNC';

      await this.stream.publishRaw(event);
    }

    this.logger.log(
      `[Validator] Sync batch: ${points.length} points queued for participant ${participantId}`,
    );
  }

  // ─── Private ─────────────────────────────────────────────────

  private normalise(raw: RawIngestPayload): TrackingEvent {
    return {
      eventId: raw.eventId,
      participantId: raw.participantId,
      userId: raw.userId,
      messageId: raw.msgId,

      lat: parseFloat(raw.lat as string),
      lng: parseFloat(raw.lng as string),
      altitude: raw.altitude != null && !isNaN(parseFloat(raw.altitude as string)) ? parseFloat(raw.altitude as string) : undefined,
      speedFromClient: parseFloat(raw.speed as string) || 0,

      // Enrichment consumer will populate these
      speedCalculated: null,
      distanceDelta: null,

      capturedAt: raw.capturedAt
        ? new Date(raw.capturedAt).toISOString()
        : new Date().toISOString(),
      serverReceivedAt: new Date().toISOString(),

      // Flags start empty — enrichment consumer will set them
      flags: {
        isAnomaly: false,
        isStopped: false,
        isOffline: false,
        isLate: false,
      },

      battery: raw.battery != null && !isNaN(parseInt(raw.battery as string)) ? parseInt(raw.battery as string) : undefined,
      clientStatus: raw.status || 'moving',
      gatekeeperAction: 'VALID', // Default; enrichment may change to ANOMALY/LATE
    };
  }
}
