import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import {
  ProcessedRoute,
  TrackingEvent,
} from '../../common/interfaces/tracking-event.interface';

/**
 * ProgressEngine — GPX-based route progress calculation (HARDENED).
 *
 * Hardening additions over Phase 1:
 *   - Graduated snap fallback: ±5 → ±20 → last valid (prevents stuck progress)
 *   - Backward movement tracking with penalty flag
 *   - Finish threshold corrected: progress >= 98% AND distanceToFinish < 20m
 *   - Consecutive snap failure counter in Redis
 *
 * Performance: O(k) where k = segment window size (20 max) → O(1) amortized.
 */
@Injectable()
export class ProgressEngine {
  private readonly logger = new Logger(ProgressEngine.name);

  /** Track consecutive snap failures per participant (in-memory, reset on success). */
  private snapFailures: Map<string, number> = new Map();

  constructor(private readonly redisService: RedisService) {}

  async compute(
    event: TrackingEvent,
    route: ProcessedRoute,
  ): Promise<{
    progressPercentage: number;
    distanceToFinish: number;
    snappedLat: number;
    snappedLng: number;
    lastSegmentIdx: number;
    checkpointsCompleted: number;
    backwardMovement: boolean;
    isFinished: boolean;
    snapDist: number;
  }> {
    const { eventId, participantId, lat, lng } = event;
    const failKey = `${eventId}:${participantId}`;

    // ── Read previous progress state ─────────────────────────────
    const prevState = await this.redisService.getProgressState(
      eventId,
      participantId,
    );
    const lastSegmentIdx = prevState.lastSegmentIdx
      ? parseInt(prevState.lastSegmentIdx, 10)
      : 0;
    const prevCheckpoints = prevState.checkpointsCompleted
      ? parseInt(prevState.checkpointsCompleted, 10)
      : 0;
    const prevProgress = prevState.progress
      ? parseFloat(prevState.progress)
      : 0;

    // ── Graduated Snap Search ────────────────────────────────────
    // Phase 1: try ±5 window (normal case)
    let snapResult = this.findBestSnap(route, lat, lng, lastSegmentIdx, 5, 15);

    // Phase 2: if snap distance > 100m, expand to ±20 (GPS drift recovery)
    if (snapResult.bestDist > 100) {
      const consecutiveFails = (this.snapFailures.get(failKey) || 0) + 1;
      this.snapFailures.set(failKey, consecutiveFails);

      if (consecutiveFails >= 3) {
        // After 3 consecutive failures in ±5, try ±20
        snapResult = this.findBestSnap(route, lat, lng, lastSegmentIdx, 20, 25);

        if (snapResult.bestDist > 100) {
          // Still can't snap — fallback to last valid position
          this.logger.warn(
            `[Progress] ⚠️ Snap failed for participant ${participantId} (${Math.round(snapResult.bestDist)}m). Using last valid.`,
          );

          // Prevent snapDistance collapse: do NOT fullScan the entire route,
          // because in a looping track it will find a false-positive close segment.
          // Just use the local window's bestDist.
          const fallbackSnapDist = snapResult.bestDist;

          const result = {
            progressPercentage: prevProgress,
            distanceToFinish: prevState.distToFinish
              ? parseInt(prevState.distToFinish, 10)
              : 0,
            snappedLat: prevState.snappedLat
              ? parseFloat(prevState.snappedLat)
              : route.coordinates[0][1],
            snappedLng: prevState.snappedLng
              ? parseFloat(prevState.snappedLng)
              : route.coordinates[0][0],
            lastSegmentIdx,
            checkpointsCompleted: prevCheckpoints,
            backwardMovement: false,
            isFinished: false,
            snapDist: fallbackSnapDist,
          };
          return result;
        }
      } else {
        // Haven't hit 3 consecutive failures yet — still use the best we found
        // (the ±5 result may be good enough even at > 100m for now)
      }
    } else {
      // Good snap — reset failure counter
      this.snapFailures.delete(failKey);
    }

    const { bestSegIdx, bestFraction, bestSnappedLat, bestSnappedLng } =
      snapResult;

    // ── Compute progress ─────────────────────────────────────────
    const segmentLength =
      route.cumulativeDistances[bestSegIdx + 1] -
      route.cumulativeDistances[bestSegIdx];
    const distAlongRoute =
      route.cumulativeDistances[bestSegIdx] + segmentLength * bestFraction;

    let progressPercentage = (distAlongRoute / route.totalDistance) * 100;
    progressPercentage = Math.max(0, Math.min(100, progressPercentage));

    const distanceToFinish = Math.max(0, route.totalDistance - distAlongRoute);

    // ── Backward movement detection ──────────────────────────────
    const backwardMovement = progressPercentage < prevProgress - 0.5; // 0.5% tolerance

    // ── Compute checkpoints (25%, 50%, 75%) — monotonic ──────────
    let checkpointsCompleted = 0;
    if (progressPercentage >= 25) checkpointsCompleted = 1;
    if (progressPercentage >= 50) checkpointsCompleted = 2;
    if (progressPercentage >= 75) checkpointsCompleted = 3;
    checkpointsCompleted = Math.max(checkpointsCompleted, prevCheckpoints);

    // ── Hardened finish detection ────────────────────────────────
    // Must be >= 98% AND < 20m from finish line
    const isFinished = progressPercentage >= 98 && distanceToFinish < 20;

    // ── Persist progress state ───────────────────────────────────
    const result = {
      progressPercentage: Math.round(progressPercentage * 100) / 100,
      distanceToFinish: Math.round(distanceToFinish),
      snappedLat: bestSnappedLat,
      snappedLng: bestSnappedLng,
      lastSegmentIdx: bestSegIdx,
      checkpointsCompleted,
      backwardMovement,
      isFinished,
      snapDist: snapResult.bestDist,
    };

    await this.redisService.setProgressState(eventId, participantId, result);

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  //  SNAP SEARCH (configurable window)
  // ═══════════════════════════════════════════════════════════════

  private findBestSnap(
    route: ProcessedRoute,
    lat: number,
    lng: number,
    lastSegmentIdx: number,
    windowBefore: number,
    windowAfter: number,
  ): {
    bestDist: number;
    bestSegIdx: number;
    bestFraction: number;
    bestSnappedLat: number;
    bestSnappedLng: number;
  } {
    const searchStart = Math.max(0, lastSegmentIdx - windowBefore);
    const searchEnd = Math.min(
      route.segmentCount,
      lastSegmentIdx + windowAfter,
    );

    let bestDist = Infinity;
    let bestSegIdx = lastSegmentIdx;
    let bestFraction = 0;
    let bestSnappedLat = lat;
    let bestSnappedLng = lng;

    for (let i = searchStart; i < searchEnd; i++) {
      const [aLng, aLat] = route.coordinates[i];
      const [bLng, bLat] = route.coordinates[i + 1];

      const { dist, fraction, closestLat, closestLng } =
        this.projectPointOnSegment(lat, lng, aLat, aLng, bLat, bLng);

      if (dist < bestDist) {
        bestDist = dist;
        bestSegIdx = i;
        bestFraction = fraction;
        bestSnappedLat = closestLat;
        bestSnappedLng = closestLng;
      }
    }

    return {
      bestDist,
      bestSegIdx,
      bestFraction,
      bestSnappedLat,
      bestSnappedLng,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  GEOMETRY — Point-to-segment projection (Euclidean approx)
  // ═══════════════════════════════════════════════════════════════

  private projectPointOnSegment(
    pLat: number,
    pLng: number,
    aLat: number,
    aLng: number,
    bLat: number,
    bLng: number,
  ): {
    dist: number;
    fraction: number;
    closestLat: number;
    closestLng: number;
  } {
    const cosLat = Math.cos((((pLat + aLat) / 2) * Math.PI) / 180);
    const M_PER_DEG_LAT = 111_320;
    const M_PER_DEG_LNG = 111_320 * cosLat;

    const px = (pLng - aLng) * M_PER_DEG_LNG;
    const py = (pLat - aLat) * M_PER_DEG_LAT;
    const bx = (bLng - aLng) * M_PER_DEG_LNG;
    const by = (bLat - aLat) * M_PER_DEG_LAT;

    const segLenSq = bx * bx + by * by;

    let fraction: number;
    if (segLenSq === 0) {
      fraction = 0;
    } else {
      fraction = Math.max(0, Math.min(1, (px * bx + py * by) / segLenSq));
    }

    const closestX = fraction * bx;
    const closestY = fraction * by;

    const dx = px - closestX;
    const dy = py - closestY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const closestLng = aLng + closestX / M_PER_DEG_LNG;
    const closestLat = aLat + closestY / M_PER_DEG_LAT;

    return { dist, fraction, closestLat, closestLng };
  }
}
