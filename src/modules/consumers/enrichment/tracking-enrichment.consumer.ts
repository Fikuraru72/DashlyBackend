import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, Job } from 'bullmq';
import { TrackingStreamService } from '../../stream/tracking-stream.service';
import { RedisService } from '../../redis/redis.service';
import { DB_CONNECTION } from '../../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../../db/schema';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';

import {
  TrackingEvent,
  QUEUE_TRACKING_RAW,
  IntelligenceResult,
  ProcessedRoute,
} from '../../common/interfaces/tracking-event.interface';

// Phase 1 Intelligence Engines
import { ProgressEngine } from '../intelligence/progress.engine';
import { RankingEngine } from '../intelligence/ranking.engine';
import { OffRouteEngine } from '../intelligence/offroute.engine';
import { StopDetectorEngine } from '../intelligence/stopdetector.engine';
import { EventsGateway } from '../../websocket/events.gateway';

/**
 * TrackingEnrichmentConsumer — HARDENED (Phase 1.5).
 *
 * Production hardening additions:
 *   - Feature flags (ENABLE_RANKING, ENABLE_OFFROUTE, ENABLE_STOP_DETECTION)
 *   - Single-flight DB fallback on Redis miss (anti thundering herd)
 *   - Queue backpressure warning (> 5000 events)
 *   - Structured JSON observability logs
 *   - Replay buffer for debugging (last 100 events per participant)
 *   - Per-message processing latency measurement
 */
@Injectable()
export class TrackingEnrichmentConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrackingEnrichmentConsumer.name);
  private worker!: Worker;
  private workerConnection!: Redis;

  // In-memory caches
  private routeMemoryCache: Map<number, ProcessedRoute> = new Map();
  private eventCategoryCache: Map<number, string> = new Map();

  // Feature flags (loaded from env)
  private enableRanking = true;
  private enableOffRoute = true;
  private enableStopDetection = true;

  // Observability counters
  private dropCountNoise = 0;
  private dropCountDuplicate = 0;
  private anomalyCount = 0;

  constructor(
    private readonly stream: TrackingStreamService,
    private readonly redisService: RedisService,
    private readonly progressEngine: ProgressEngine,
    private readonly rankingEngine: RankingEngine,
    private readonly offRouteEngine: OffRouteEngine,
    private readonly stopDetector: StopDetectorEngine,
    private readonly wsGateway: EventsGateway,
    private readonly configService: ConfigService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  onModuleInit() {
    // ── Load feature flags from environment ──────────────────────
    this.enableRanking =
      this.configService.get('ENABLE_RANKING', 'true') !== 'false';
    this.enableOffRoute =
      this.configService.get('ENABLE_OFFROUTE', 'true') !== 'false';
    this.enableStopDetection = false;

    this.logger.log(
      `Feature flags: ranking=${this.enableRanking}, offRoute=${this.enableOffRoute}, stopDetection=${this.enableStopDetection}`,
    );

    this.workerConnection = this.stream.createWorkerConnection();

    this.worker = new Worker(
      QUEUE_TRACKING_RAW,
      async (job: Job<TrackingEvent>) => {
        await this.process(job.data);
      },
      {
        connection: this.workerConnection as any,
        concurrency: 1,
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Enrichment job ${job?.id} failed:`, err);
    });

    this.logger.log(
      'Enrichment consumer started (HARDENED) on queue: ' + QUEUE_TRACKING_RAW,
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.workerConnection?.quit();
  }

  // ═══════════════════════════════════════════════════════════════
  //  CORE PROCESSING LOGIC (HARDENED)
  // ═══════════════════════════════════════════════════════════════

  private async process(event: TrackingEvent): Promise<void> {
    const startMs = Date.now();
    const { eventId, participantId, messageId, lat, lng } = event;
    const capturedAtMs = new Date(event.capturedAt).getTime();

    // ── 0. Register event for ranking flush ───────────────────────
    this.rankingEngine.registerActiveEvent(eventId);

    // ── 1. Deduplication ─────────────────────────────────────────
    const isDuplicate = await this.redisService.isMessageProcessed(
      eventId,
      messageId,
    );
    if (isDuplicate) {
      this.dropCountDuplicate++;
      return;
    }

    // ── 2. Read previous state (with single-flight DB fallback) ──
    let prevStats = await this.redisService.getParticipantStats(participantId);

    let lastTime = 0;
    let lastLat: number | null = null;
    let lastLng: number | null = null;
    let currentState = 'REGISTERED';

    // Single-flight DB fallback on Redis miss
    if (!prevStats.captured_at) {
      prevStats = await this.singleFlightDbFallback(participantId, eventId);
    }

    if (prevStats.captured_at) {
      lastTime = parseInt(prevStats.captured_at, 10);
      lastLat = parseFloat(prevStats.lat);
      lastLng = parseFloat(prevStats.lng);
    }
    if (prevStats.participantState) {
      currentState = prevStats.participantState;
    }

    // ── 3. State Machine Fast-Fail (Strict Whitelist) ────────────
    if (currentState !== 'TRACKING') {
      this.logger.debug(
        `[Consumer] Participant ${participantId} is not TRACKING (${currentState}), dropping.`,
      );
      return;
    }

    this.logger.debug(
      `[Consumer] Processing event for participant ${participantId} at ${lat}, ${lng}`,
    );

    // ── 4. Timestamp ordering ────────────────────────────────────
    if (lastTime > 0 && capturedAtMs <= lastTime) {
      event.flags.isLate = true;
      event.gatekeeperAction = 'LATE';
      await this.stream.publishEnriched(event);
      return;
    }

    // ── 5. Haversine distance + speed calculation ────────────────
    let distanceDelta = 0;
    let speedCalculated = event.speedFromClient;

    if (lastLat !== null && lastLng !== null) {
      distanceDelta = this.calculateHaversineDistance(
        lastLat,
        lastLng,
        lat,
        lng,
      );
      const timeDeltaSec = (capturedAtMs - lastTime) / 1000;

      if (timeDeltaSec > 0) {
        speedCalculated = distanceDelta / timeDeltaSec;
      }

      // Noise filter
      if (distanceDelta < 5 && speedCalculated < 1.0) {
        this.dropCountNoise++;
        event.flags.isNoise = true;
        // Proceed instead of returning, so Stop Detection and Redis updates occur.
      }

      // Anomaly flag
      if (speedCalculated > 25.0) {
        event.flags.isAnomaly = true;
        event.gatekeeperAction = 'ANOMALY';
        this.anomalyCount++;
      }
    }

    event.distanceDelta = distanceDelta;
    event.speedCalculated = speedCalculated;

    // ── 6. Event Intelligence Layer (HARDENED) ───────────────────
    const route = await this.getRoute(eventId);
    if (route) {
      this.logger.debug(
        `[Consumer] Route found for event ${eventId}, processing intelligence.`,
      );
      // Engine A: Progress (hardened — graduated snap fallback)
      const progressResult = await this.progressEngine.compute(event, route);

      // Engine B: Off-Route (hardened — cooldown, dynamic threshold, speed gate)
      let offRouteResult = {
        offRoute: false,
        offRouteDistance: 0,
        consecutiveCount: 0,
        alertEmitted: false,
      };
      if (this.enableOffRoute) {
        const snapDistance = progressResult.snapDist;
        offRouteResult = await this.offRouteEngine.compute(
          eventId,
          participantId,
          snapDistance,
          route,
          progressResult.lastSegmentIdx,
          speedCalculated,
        );

        if (offRouteResult.alertEmitted) {
          this.wsGateway.broadcastOffRouteAlert(eventId, {
            participantId,
            userId: event.userId,
            lat,
            lng,
            type: 'OFF_ROUTE',
            distance: offRouteResult.offRouteDistance,
            message: `Participant deviated ${Math.round(offRouteResult.offRouteDistance)} meters from the route.`,
            timestamp: new Date().toISOString(),
          });

          this.logger.warn(
            `[TrackingEnrichment] ⚠️ Persisting OFF_ROUTE anomaly for Participant ${participantId} (${Math.round(offRouteResult.offRouteDistance)}m)`,
          );
          await this.db.insert(schema.anomalies).values({
            eventId,
            userId: event.userId,
            latitude: lat,
            longitude: lng,
            type: 'OFF_ROUTE',
            reason: `Participant deviated ${Math.round(offRouteResult.offRouteDistance)} meters from the route.`,
          });
        }
      }

      // Engine C: Stop Detection (hardened — multi-signal, drift filter, state-aware)
      let stopResult = {
        stopped: false,
        stoppedDurationSec: 0,
        justStopped: false,
      };
      if (this.enableStopDetection) {
        stopResult = await this.stopDetector.compute(
          eventId,
          participantId,
          speedCalculated,
          currentState,
          lat,
          lng,
          capturedAtMs,
        );

        if (stopResult.justStopped) {
          this.wsGateway.broadcastUserStopped(eventId, {
            participantId,
            userId: event.userId,
            lat,
            lng,
            type: 'STOP',
            durationSec: stopResult.stoppedDurationSec,
            message: `Participant stopped for ${stopResult.stoppedDurationSec} seconds.`,
            timestamp: new Date().toISOString(),
          });

          this.logger.warn(
            `[TrackingEnrichment] ⚠️ Persisting STOP anomaly for Participant ${participantId} (${stopResult.stoppedDurationSec}s)`,
          );
          await this.db.insert(schema.anomalies).values({
            eventId,
            userId: event.userId,
            latitude: lat,
            longitude: lng,
            type: 'STOP',
            reason: `Participant stopped for ${stopResult.stoppedDurationSec} seconds.`,
          });
        }
      }

      // Engine D: Ranking (hardened — speed smoothing, clamping, anomaly exclusion, delta stabilization)
      let rankResult = { score: 0, rank: 1, totalParticipants: 1 };
      if (this.enableRanking) {
        const eventCategory = await this.getEventCategory(eventId);
        rankResult = await this.rankingEngine.compute(
          eventId,
          participantId,
          progressResult.progressPercentage,
          speedCalculated,
          progressResult.checkpointsCompleted,
          eventCategory,
          event.flags.isAnomaly, // anomaly exclusion
          progressResult.backwardMovement, // backward penalty
        );
      }

      // ── 7. Auto-Finish Enforcement (hardened: 98% + <20m) ─────
      let finalState = currentState;
      if (progressResult.isFinished) {
        finalState = 'FINISHED';

        await this.db
          .update(schema.eventParticipants)
          .set({ participantState: 'FINISHED' })
          .where(eq(schema.eventParticipants.id, participantId));
        this.wsGateway.broadcastParticipantFinished(eventId, {
          participantId,
          userId: event.userId,
          lat,
          lng,
          rank: rankResult.rank,
          score: rankResult.score,
          timestamp: new Date().toISOString(),
        });
      }

      // ── 8. Attach Intelligence Result ──────────────────────────
      event.intelligence = {
        progressPercentage: progressResult.progressPercentage,
        distanceToFinish: progressResult.distanceToFinish,
        snappedLat: progressResult.snappedLat,
        snappedLng: progressResult.snappedLng,
        rank: rankResult.rank,
        totalParticipants: rankResult.totalParticipants,
        offRoute: offRouteResult.offRoute,
        offRouteDistance: offRouteResult.offRouteDistance,
        stopped: stopResult.stopped,
        stoppedDurationSec: stopResult.stoppedDurationSec,
        score: rankResult.score,
        participantState: finalState,
      };

      // Broadcast ranking update
      this.wsGateway.broadcastRankingUpdate(eventId, {
        participantId,
        intelligence: event.intelligence,
      });

      currentState = finalState;
    }

    // ── 9. Update Redis cache with new state ─────────────────────
    await this.redisService.updateParticipantState(eventId, participantId, {
      lat,
      lng,
      speed: speedCalculated,
      isOffline: event.flags.isOffline,
      capturedAt: capturedAtMs,
    });

    const statsKey = `participant_stats:${participantId}`;
    await this.redisService['redisClient'].hset(
      statsKey,
      'participantState',
      currentState,
    );

    // ── 10. Replay buffer (memory-safe: 100 events, 10m TTL) ────
    await this.redisService.pushEventToReplayBuffer(participantId, event);

    // ── 11. Publish enriched event downstream ────────────────────
    await this.stream.publishEnriched(event);

    // ── 12. Structured observability log ─────────────────────────
    const processingMs = Date.now() - startMs;
    this.logger.log(
      JSON.stringify({
        type: 'ENRICHMENT_COMPLETE',
        participantId,
        eventId,
        action: event.gatekeeperAction || 'VALID',
        progress: event.intelligence?.progressPercentage ?? null,
        rank: event.intelligence?.rank ?? null,
        score: event.intelligence?.score ?? null,
        offRoute: event.intelligence?.offRoute ?? false,
        stopped: event.intelligence?.stopped ?? false,
        processingMs,
        dropsDuplicate: this.dropCountDuplicate,
        dropsNoise: this.dropCountNoise,
        anomalyCount: this.anomalyCount,
      }),
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  SINGLE-FLIGHT DB FALLBACK (Anti Thundering Herd)
  // ═══════════════════════════════════════════════════════════════

  private async singleFlightDbFallback(
    participantId: number,
    eventId: number,
  ): Promise<Record<string, string>> {
    const lockKey = `lock:participant_fallback:${participantId}`;

    const acquired = await this.redisService.acquireLock(lockKey, 5000); // 5s TTL
    if (!acquired) {
      // Another worker is already fetching — skip this round
      this.logger.debug(
        `[Fallback] Lock held for participant ${participantId}, skipping DB fetch`,
      );
      return {};
    }

    try {
      // Fetch last known state from DB
      const [participant] = await this.db
        .select({
          state: schema.eventParticipants.participantState,
        })
        .from(schema.eventParticipants)
        .where(eq(schema.eventParticipants.id, participantId));

      if (participant) {
        // Seed Redis with the DB state
        const statsKey = `participant_stats:${participantId}`;
        await this.redisService['redisClient'].hset(
          statsKey,
          'participantState',
          participant.state,
        );
        await this.redisService['redisClient'].expire(statsKey, 60);

        this.logger.log(
          `[Fallback] 🔄 Seeded Redis from DB for participant ${participantId} (state=${participant.state})`,
        );
        return { participantState: participant.state };
      }

      return {};
    } catch (err) {
      this.logger.error(
        `[Fallback] DB fetch failed for participant ${participantId}`,
        err,
      );
      return {};
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════

  private async getRoute(eventId: number): Promise<ProcessedRoute | null> {
    if (this.routeMemoryCache.has(eventId)) {
      return this.routeMemoryCache.get(eventId)!;
    }

    const cached = await this.redisService.getCachedRoute(eventId);
    if (cached) {
      const route = JSON.parse(cached) as ProcessedRoute;
      this.routeMemoryCache.set(eventId, route);
      return route;
    }

    const [eventRow] = await this.db
      .select({ routeGeojson: schema.events.routeGeojson })
      .from(schema.events)
      .where(eq(schema.events.id, eventId));

    if (!eventRow || !eventRow.routeGeojson) return null;

    const geojson = eventRow.routeGeojson as any;
    this.logger.debug(
      `[getRoute] geojson typeof=${typeof geojson}, isArray=${Array.isArray(geojson)}`,
    );

    let parsedGeojson = geojson;
    if (typeof geojson === 'string') {
      try {
        parsedGeojson = JSON.parse(geojson);
      } catch (e) {}
    }

    let coordinates: [number, number][] = [];

    if (
      parsedGeojson.type === 'FeatureCollection' &&
      parsedGeojson.features &&
      parsedGeojson.features.length > 0
    ) {
      const feature = parsedGeojson.features.find(
        (f: any) => f.geometry && f.geometry.type === 'LineString',
      );
      if (feature) coordinates = feature.geometry.coordinates;
    } else if (parsedGeojson.type === 'LineString') {
      coordinates = parsedGeojson.coordinates;
    } else if (parsedGeojson.coordinates) {
      coordinates = parsedGeojson.coordinates;
    }

    this.logger.debug(`[getRoute] coordinates length=${coordinates?.length}`);

    if (!coordinates || !Array.isArray(coordinates) || coordinates.length === 0)
      return null;
    const cumulativeDistances = [0];
    let totalDist = 0;

    for (let i = 1; i < coordinates.length; i++) {
      const [prevLng, prevLat] = coordinates[i - 1];
      const [currLng, currLat] = coordinates[i];
      const d = this.calculateHaversineDistance(
        prevLat,
        prevLng,
        currLat,
        currLng,
      );
      totalDist += d;
      cumulativeDistances.push(totalDist);
    }

    const processedRoute: ProcessedRoute = {
      coordinates,
      cumulativeDistances,
      totalDistance: totalDist,
      segmentCount: coordinates.length - 1,
    };

    await this.redisService.setCachedRoute(
      eventId,
      JSON.stringify(processedRoute),
    );
    this.routeMemoryCache.set(eventId, processedRoute);
    this.enforceCacheLimit(this.routeMemoryCache, 20);

    return processedRoute;
  }

  private enforceCacheLimit(map: Map<number, any>, limit: number) {
    if (map.size > limit) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) map.delete(firstKey);
    }
  }

  private async getEventCategory(eventId: number): Promise<string> {
    // In-memory cache for event category (immutable per event)
    if (this.eventCategoryCache.has(eventId)) {
      return this.eventCategoryCache.get(eventId)!;
    }
    const [ev] = await this.db
      .select({ cat: schema.events.category })
      .from(schema.events)
      .where(eq(schema.events.id, eventId));
    const cat = ev?.cat || 'RUNNING';
    this.eventCategoryCache.set(eventId, cat);
    this.enforceCacheLimit(this.eventCategoryCache, 100);
    return cat;
  }

  private calculateEuclideanDist(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const M_PER_DEG_LAT = 111_320;
    const cosLat = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
    const M_PER_DEG_LNG = 111_320 * cosLat;

    const dx = (lng2 - lng1) * M_PER_DEG_LNG;
    const dy = (lat2 - lat1) * M_PER_DEG_LAT;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private calculateHaversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}
