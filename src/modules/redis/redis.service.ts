import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { Redis as RedisClient } from 'ioredis';

import { getRedisOptions } from './redis-options';

/**
 * RedisService — DUMB CACHE ONLY.
 *
 * Provides primitive get/set operations for:
 *   - Participant state (last known position, speed, timestamps)
 *   - Geospatial position index (GEOADD / GEOPOS)
 *   - Identity cache (participantId → userId)
 *
 * ⚠️  NO business logic lives here. No haversine, no filtering decisions,
 *     no anomaly detection. All intelligence belongs in consumers.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private redisClient!: RedisClient;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.redisClient = new Redis(getRedisOptions(this.configService));
    this.redisClient.on('error', (err) => this.logger.error('Redis connection error', err));
  }

  async onModuleDestroy() {
    await this.redisClient.quit();
  }

  // ═══════════════════════════════════════════════════════════════
  //  PARTICIPANT STATE (READ)
  // ═══════════════════════════════════════════════════════════════

  async getParticipantStats(participantId: number): Promise<Record<string, string>> {
    const key = `participant_stats:${participantId}`;
    return this.redisClient.hgetall(key);
  }

  async getParticipantPosition(
    eventId: number,
    participantId: number,
  ): Promise<{ lat: number; lng: number } | null> {
    const key = `current_positions:${eventId}`;
    const pos = await this.redisClient.geopos(key, participantId.toString());
    if (pos && pos[0]) {
      return {
        lng: parseFloat(pos[0][0]),
        lat: parseFloat(pos[0][1]),
      };
    }
    return null;
  }

  async getAllParticipantPositions(eventId: number) {
    const geoKey = `current_positions:${eventId}`;
    const members = await this.redisClient.zrange(geoKey, 0, -1);
    if (members.length === 0) return [];

    const results: any[] = [];
    for (const participantId of members) {
      const pos = await this.redisClient.geopos(geoKey, participantId);
      const stats = await this.getParticipantStats(parseInt(participantId, 10));

      if (pos && pos[0]) {
        const isStatsEmpty = Object.keys(stats).length === 0;

        results.push({
          participantId: parseInt(participantId, 10),
          userId: stats.userId ? parseInt(stats.userId, 10) : parseInt(participantId, 10),
          lat: parseFloat(pos[0][1]),
          lng: parseFloat(pos[0][0]),
          ...stats,
          isOffline: isStatsEmpty ? 'true' : stats.isOffline || 'false',
        });
      }
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PARTICIPANT STATE (WRITE)
  // ═══════════════════════════════════════════════════════════════

  async updateParticipantState(
    eventId: number,
    participantId: number,
    state: {
      lat: number;
      lng: number;
      altitude?: number;
      speed: number;
      isOffline: boolean;
      capturedAt: number; // epoch ms
      elevationGain: number;
      minAltitude: number;
      maxAltitude: number;
    },
  ): Promise<void> {
    const geoKey = `current_positions:${eventId}`;
    const statsKey = `participant_stats:${participantId}`;

    const pipeline = this.redisClient.pipeline();
    pipeline.geoadd(geoKey, state.lng, state.lat, participantId.toString());
    pipeline.hset(statsKey, {
      lat: state.lat.toString(),
      lng: state.lng.toString(),
      ...(state.altitude != null && { altitude: state.altitude.toString() }),
      elevation_gain: state.elevationGain.toString(),
      min_altitude: state.minAltitude.toString(),
      max_altitude: state.maxAltitude.toString(),
      speed: state.speed.toString(),
      isOffline: state.isOffline ? 'true' : 'false',
      captured_at: state.capturedAt.toString(),
      last_seen: new Date().toISOString(),
      last_moved: new Date().toISOString(),
    });
    pipeline.expire(statsKey, 60);
    pipeline.expire(geoKey, 86400);
    await pipeline.exec();
  }

  async setParticipantOffline(eventId: number, participantId: number): Promise<void> {
    const statsKey = `participant_stats:${participantId}`;
    await this.redisClient.hset(statsKey, 'isOffline', 'true');
    await this.redisClient.expire(statsKey, 60);
  }

  async setParticipantOnline(eventId: number, participantId: number): Promise<void> {
    const statsKey = `participant_stats:${participantId}`;
    await this.redisClient.hset(statsKey, {
      isOffline: 'false',
      participantState: 'TRACKING',
    });
    await this.redisClient.expire(statsKey, 60);
  }

  async setParticipantStateOnly(
    eventId: number,
    participantId: number,
    state: string,
  ): Promise<void> {
    const statsKey = `participant_stats:${participantId}`;
    await this.redisClient.hset(statsKey, 'participantState', state);
  }

  // ═══════════════════════════════════════════════════════════════
  //  IDENTITY CACHE (participantId → userId)
  // ═══════════════════════════════════════════════════════════════

  async getCachedParticipant(participantKey: string | number): Promise<number | null> {
    const key = `identity:${participantKey}`;
    const val = await this.redisClient.get(key);
    return val ? parseInt(val, 10) : null;
  }

  async setCachedParticipant(participantKey: string | number, userId: number): Promise<void> {
    const key = `identity:${participantKey}`;
    await this.redisClient.set(key, userId.toString(), 'EX', 3600); // 1 hour
  }

  // ═══════════════════════════════════════════════════════════════
  //  EVENT STATUS CACHE
  // ═══════════════════════════════════════════════════════════════

  async getCachedEventStatus(eventId: number): Promise<string | null> {
    const key = `event_status:${eventId}`;
    return this.redisClient.get(key);
  }

  async setCachedEventStatus(eventId: number, status: string): Promise<void> {
    const key = `event_status:${eventId}`;
    await this.redisClient.set(key, status, 'EX', 10); // 10 second TTL
  }

  // ═══════════════════════════════════════════════════════════════
  //  ROUTE CACHE (pre-processed GPX route)
  // ═══════════════════════════════════════════════════════════════

  async getCachedRoute(eventId: number): Promise<string | null> {
    const key = `route_cache:${eventId}`;
    return this.redisClient.get(key);
  }

  async setCachedRoute(eventId: number, routeJson: string): Promise<void> {
    const key = `route_cache:${eventId}`;
    await this.redisClient.set(key, routeJson, 'EX', 86400); // 24 hour TTL
  }

  // ═══════════════════════════════════════════════════════════════
  //  RANKING (Redis Sorted Set)
  // ═══════════════════════════════════════════════════════════════

  async updateRankingScore(eventId: number, participantId: number, score: number): Promise<void> {
    const key = `ranking:${eventId}`;
    await this.redisClient.zadd(key, score, participantId.toString());
    await this.redisClient.expire(key, 86400);
  }

  /** Returns 0-based rank (null if not in set). Caller should add 1 for display. */
  async getRank(eventId: number, participantId: number): Promise<number | null> {
    const key = `ranking:${eventId}`;
    const rank = await this.redisClient.zrevrank(key, participantId.toString());
    return rank;
  }

  async getTotalRanked(eventId: number): Promise<number> {
    const key = `ranking:${eventId}`;
    return this.redisClient.zcard(key);
  }

  /** Returns all members sorted by score descending: [{ participantId, score }] */
  async getAllRankings(eventId: number): Promise<{ participantId: number; score: number }[]> {
    const key = `ranking:${eventId}`;
    const raw = await this.redisClient.zrevrange(key, 0, -1, 'WITHSCORES');
    const result: { participantId: number; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      result.push({
        participantId: parseInt(raw[i], 10),
        score: parseFloat(raw[i + 1]),
      });
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PROGRESS CACHE (per-participant progress state)
  // ═══════════════════════════════════════════════════════════════

  async getProgressState(eventId: number, participantId: number): Promise<Record<string, string>> {
    const key = `progress:${eventId}:${participantId}`;
    return this.redisClient.hgetall(key);
  }

  async setProgressState(
    eventId: number,
    participantId: number,
    state: {
      progressPercentage: number;
      distanceToFinish: number;
      snappedLat: number;
      snappedLng: number;
      lastSegmentIdx: number;
      checkpointsCompleted: number;
    },
  ): Promise<void> {
    const key = `progress:${eventId}:${participantId}`;
    await this.redisClient.hset(key, {
      progress: state.progressPercentage.toString(),
      distToFinish: state.distanceToFinish.toString(),
      snappedLat: state.snappedLat.toString(),
      snappedLng: state.snappedLng.toString(),
      lastSegmentIdx: state.lastSegmentIdx.toString(),
      checkpointsCompleted: state.checkpointsCompleted.toString(),
    });
    await this.redisClient.expire(key, 60);
  }

  // ═══════════════════════════════════════════════════════════════
  //  OFF-ROUTE COUNTER
  // ═══════════════════════════════════════════════════════════════

  async getOffRouteCount(eventId: number, participantId: number): Promise<number> {
    const key = `offroute:${eventId}:${participantId}`;
    const val = await this.redisClient.get(key);
    return val ? parseInt(val, 10) : 0;
  }

  async setOffRouteCount(eventId: number, participantId: number, count: number): Promise<void> {
    const key = `offroute:${eventId}:${participantId}`;
    if (count === 0) {
      await this.redisClient.del(key);
    } else {
      await this.redisClient.set(key, count.toString(), 'EX', 300); // 5 min TTL
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  STOP DETECTION TIMESTAMP
  // ═══════════════════════════════════════════════════════════════

  /** Returns stop state: { anchorLat, anchorLng, startTimeMs }, or null. */
  async getStopState(
    eventId: number,
    participantId: number,
  ): Promise<{
    anchorLat: number;
    anchorLng: number;
    startTimeMs: number;
  } | null> {
    const key = `stopdetect:${eventId}:${participantId}`;
    const val = await this.redisClient.hgetall(key);
    if (Object.keys(val).length === 0) return null;
    return {
      anchorLat: parseFloat(val.anchorLat),
      anchorLng: parseFloat(val.anchorLng),
      startTimeMs: parseInt(val.startTimeMs, 10),
    };
  }

  async setStopState(
    eventId: number,
    participantId: number,
    anchorLat: number,
    anchorLng: number,
    startTimeMs: number,
  ): Promise<void> {
    const key = `stopdetect:${eventId}:${participantId}`;
    await this.redisClient.hset(key, {
      anchorLat: anchorLat.toString(),
      anchorLng: anchorLng.toString(),
      startTimeMs: startTimeMs.toString(),
    });
    await this.redisClient.expire(key, 43200); // 12 hours TTL (prevents anchor loss during long rests)
  }

  async clearStopState(eventId: number, participantId: number): Promise<void> {
    const key = `stopdetect:${eventId}:${participantId}`;
    await this.redisClient.del(key);
  }

  async getStopAlertSent(eventId: number, participantId: number): Promise<boolean> {
    const key = `stopalert:${eventId}:${participantId}`;
    const val = await this.redisClient.get(key);
    return val === 'true';
  }

  async setStopAlertSent(eventId: number, participantId: number): Promise<void> {
    const key = `stopalert:${eventId}:${participantId}`;
    await this.redisClient.set(key, 'true', 'EX', 3600); // Expiry 1 hour is plenty for a stop
  }

  async clearStopAlertSent(eventId: number, participantId: number): Promise<void> {
    const key = `stopalert:${eventId}:${participantId}`;
    await this.redisClient.del(key);
  }

  // ═══════════════════════════════════════════════════════════════
  //  PHASE 1 HARDENING (Locks, Buffers, Cooldowns)
  // ═══════════════════════════════════════════════════════════════

  /** Single-flight lock to prevent DB thundering herd on cache misses. */
  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redisClient.set(key, 'locked', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    await this.redisClient.del(key);
  }

  /** 100-event Replay Buffer for debugging. Memory safe with LTRIM and EXPIRE. */
  async pushEventToReplayBuffer(participantId: number, event: any): Promise<void> {
    const key = `replay:${participantId}`;
    const pipeline = this.redisClient.pipeline();
    pipeline.lpush(key, JSON.stringify(event));
    pipeline.ltrim(key, 0, 99); // Keep only last 100
    pipeline.expire(key, 600); // 10 minutes TTL
    await pipeline.exec();
  }

  async getReplayBuffer(participantId: number): Promise<any[]> {
    const key = `replay:${participantId}`;
    const raw = await this.redisClient.lrange(key, 0, -1);
    return raw.map((str) => JSON.parse(str));
  }

  /** Speed rolling average buffer (last 5 samples). */
  async pushSpeedBuffer(participantId: number, speed: number): Promise<void> {
    const key = `speed_buffer:${participantId}`;
    const pipeline = this.redisClient.pipeline();
    pipeline.lpush(key, speed.toString());
    pipeline.ltrim(key, 0, 4); // Keep only last 5
    pipeline.expire(key, 120); // 2 minutes TTL
    await pipeline.exec();
  }

  async getSpeedBuffer(participantId: number): Promise<number[]> {
    const key = `speed_buffer:${participantId}`;
    const raw = await this.redisClient.lrange(key, 0, -1);
    return raw.map((str) => parseFloat(str));
  }

  /** 5-event cooldown for Off-Route alerts to prevent spam. */
  async setOffRouteCooldown(participantId: number): Promise<void> {
    const key = `offroute_cooldown:${participantId}`;
    // Enforce 60 seconds cooldown to prevent dashboard alert spam
    await this.redisClient.set(key, 'cooldown', 'EX', 60);
  }

  async getOffRouteCooldown(participantId: number): Promise<boolean> {
    const key = `offroute_cooldown:${participantId}`;
    const exists = await this.redisClient.exists(key);
    return exists === 1;
  }

  // ═══════════════════════════════════════════════════════════════
  //  TRAJECTORY BUFFER (for OSRM Map Matching)
  // ═══════════════════════════════════════════════════════════════

  /** Append a GPS point to the participant's trajectory buffer (max 5 points, FIFO). */
  async pushTrajectoryPoint(
    participantId: number,
    lng: number,
    lat: number,
    timestamp: number,
  ): Promise<void> {
    const key = `trajectory:${participantId}`;
    const point = JSON.stringify({ lng, lat, timestamp });
    const pipeline = this.redisClient.pipeline();
    pipeline.rpush(key, point);
    pipeline.ltrim(key, -5, -1); // Keep only last 5 points
    pipeline.expire(key, 120); // 2 minutes TTL
    await pipeline.exec();
  }

  /** Get the full trajectory buffer as [{ lng, lat, timestamp }]. */
  async getTrajectoryBuffer(
    participantId: number,
  ): Promise<{ lng: number; lat: number; timestamp: number }[]> {
    const key = `trajectory:${participantId}`;
    const raw = await this.redisClient.lrange(key, 0, -1);
    return raw.map((str) => JSON.parse(str));
  }
}
