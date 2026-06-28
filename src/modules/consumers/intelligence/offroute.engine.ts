import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { ProcessedRoute } from '../../common/interfaces/tracking-event.interface';

/**
 * OffRouteEngine — Detects when a participant strays from the route (HARDENED).
 *
 * Hardening additions over Phase 1:
 *   - 5-event cooldown after alert to prevent spam
 *   - Dynamic threshold: 50m default, 80m near sharp turns (>45°)
 *   - Speed factor: ignore off-route if speed < 1 m/s (GPS drift)
 *
 * Complexity: O(1) — Redis get/set per event.
 */
@Injectable()
export class OffRouteEngine {
  private readonly logger = new Logger(OffRouteEngine.name);
  private readonly DEFAULT_THRESHOLD = 5; // metres (user requirement: 5m)
  private readonly SHARP_TURN_THRESHOLD = 10; // metres (near corners)
  private readonly SHARP_TURN_ANGLE_DEG = 45; // degrees
  private readonly CONSECUTIVE_COUNT_TRIGGER = 3;
  private readonly MIN_SPEED_FOR_OFFROUTE = 0.3; // m/s — below this, GPS drift is expected

  constructor(private readonly redisService: RedisService) {}

  async compute(
    eventId: number,
    participantId: number,
    snapDistanceMeters: number,
    route: ProcessedRoute | null,
    lastSegmentIdx: number,
    speedCalculated: number,
  ): Promise<{
    offRoute: boolean;
    offRouteDistance: number;
    consecutiveCount: number;
    alertEmitted: boolean;
  }> {
    this.logger.debug(
      `[DIAGNOSTIC - OFF_ROUTE] ` +
        `snapDistance=${snapDistanceMeters.toFixed(2)}m | ` +
        `nearestSegment=${lastSegmentIdx} | ` +
        `speed=${speedCalculated.toFixed(2)}m/s`,
    );

    // ── Speed gate: moving too slow = GPS drift, not off-route ───
    if (speedCalculated < this.MIN_SPEED_FOR_OFFROUTE) {
      return {
        offRoute: false,
        offRouteDistance: Math.round(snapDistanceMeters),
        consecutiveCount: 0,
        alertEmitted: false,
      };
    }

    // ── Cooldown check: suppress alerts for 5 events after trigger ─
    const isCoolingDown =
      await this.redisService.getOffRouteCooldown(participantId);
    if (isCoolingDown) {
      // Still track the count but don't emit alerts
      return {
        offRoute: snapDistanceMeters > this.DEFAULT_THRESHOLD,
        offRouteDistance: Math.round(snapDistanceMeters),
        consecutiveCount: 0, // Suppressed
        alertEmitted: false,
      };
    }

    // ── Dynamic threshold: check for sharp turns ─────────────────
    let threshold = this.DEFAULT_THRESHOLD;
    if (
      route &&
      lastSegmentIdx >= 0 &&
      lastSegmentIdx < route.segmentCount - 1
    ) {
      const angle = this.computeSegmentAngle(route, lastSegmentIdx);
      if (angle > this.SHARP_TURN_ANGLE_DEG) {
        threshold = this.SHARP_TURN_THRESHOLD;
      }
    }

    // ── Core detection logic ─────────────────────────────────────
    const currentCount = await this.redisService.getOffRouteCount(
      eventId,
      participantId,
    );

    if (snapDistanceMeters > threshold) {
      const newCount = currentCount + 1;
      await this.redisService.setOffRouteCount(
        eventId,
        participantId,
        newCount,
      );

      this.logger.debug(
        `[DIAGNOSTIC - OFF_ROUTE] EXCEEDED THRESHOLD! ` +
          `snapDistance=${snapDistanceMeters.toFixed(2)}m > threshold=${threshold}m | ` +
          `consecutiveCount=${newCount}`,
      );

      const offRoute = newCount >= this.CONSECUTIVE_COUNT_TRIGGER;
      let alertEmitted = false;

      if (offRoute) {
        this.logger.warn(
          `[OffRoute] 🚨 Participant ${participantId} OFF ROUTE (${Math.round(snapDistanceMeters)}m, threshold=${threshold}m, ${newCount} consecutive)`,
        );
        alertEmitted = true;
        // Set cooldown to prevent spam
        await this.redisService.setOffRouteCooldown(participantId);
      }

      this.logger.debug(
        JSON.stringify({
          type: 'OFF_ROUTE_CHECK',
          participantId,
          snapDistMeters: snapDistanceMeters,
          threshold,
          speed: speedCalculated,
          consecutiveCount: newCount,
          cooldown: false,
          offRoute,
          alertEmitted,
        }),
      );

      return {
        offRoute,
        offRouteDistance: Math.round(snapDistanceMeters),
        consecutiveCount: newCount,
        alertEmitted,
      };
    }

    // Back on route — handle GPS jitter and aggressive resets
    let finalCount = currentCount;

    if (snapDistanceMeters <= 20) {
      // Truly back on route -> safely decrement
      if (currentCount > 0) {
        finalCount = currentCount - 1;
        await this.redisService.setOffRouteCount(
          eventId,
          participantId,
          finalCount,
        );
        this.logger.debug(
          `[DIAGNOSTIC - OFF_ROUTE] TRULY BACK ON ROUTE. ` +
            `snapDistance=${snapDistanceMeters.toFixed(2)}m <= 20m | ` +
            `Decrementing consecutiveCount to ${finalCount}`,
        );
      }
    } else {
      // In the "gray zone" (e.g. 20m - 50m).
      // They are not completely off route, but they are not safely back either.
      // Keep the counter as is so it doesn't reset aggressively.
      this.logger.debug(
        `[DIAGNOSTIC - OFF_ROUTE] GRAY ZONE. ` +
          `snapDistance=${snapDistanceMeters.toFixed(2)}m | ` +
          `Keeping consecutiveCount at ${finalCount}`,
      );
    }

    this.logger.debug(
      JSON.stringify({
        type: 'OFF_ROUTE_CHECK',
        participantId,
        snapDistMeters: snapDistanceMeters,
        threshold,
        speed: speedCalculated,
        consecutiveCount: finalCount,
        cooldown: false,
        offRoute: false,
        alertEmitted: false,
      }),
    );

    return {
      offRoute: false,
      offRouteDistance: Math.round(snapDistanceMeters),
      consecutiveCount: finalCount,
      alertEmitted: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  GEOMETRY — Segment angle computation
  // ═══════════════════════════════════════════════════════════════

  /**
   * Computes the angle (in degrees) between consecutive route segments.
   * A straight path returns ~0°; a U-turn returns ~180°.
   */
  private computeSegmentAngle(route: ProcessedRoute, segIdx: number): number {
    if (segIdx >= route.segmentCount - 1) return 0;

    // Current segment vector
    const [aLng, aLat] = route.coordinates[segIdx];
    const [bLng, bLat] = route.coordinates[segIdx + 1];
    // Next segment vector
    const [cLng, cLat] = route.coordinates[segIdx + 2];

    const cosLat = Math.cos((bLat * Math.PI) / 180);
    const v1x = (bLng - aLng) * cosLat;
    const v1y = bLat - aLat;
    const v2x = (cLng - bLng) * cosLat;
    const v2y = cLat - bLat;

    const dot = v1x * v2x + v1y * v2y;
    const cross = v1x * v2y - v1y * v2x;

    const angleDeg = Math.abs((Math.atan2(cross, dot) * 180) / Math.PI);
    return angleDeg;
  }
}
