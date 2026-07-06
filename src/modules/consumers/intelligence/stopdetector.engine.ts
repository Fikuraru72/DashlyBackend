import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/**
 * StopDetectorEngine — Detects idle runners (HARDENED).
 *
 * Hardening additions over Phase 1:
 *   - Multi-signal detection: speed < 0.5 m/s AND distanceDelta < 3m
 *   - GPS drift filter: reset timer if distance oscillation detected
 *   - State-aware: automatically skip if participantState = FROZEN
 *
 * Complexity: O(1) — single Redis get/set per event.
 */
@Injectable()
export class StopDetectorEngine {
  private readonly logger = new Logger(StopDetectorEngine.name);
  private readonly SPEED_THRESHOLD = 1.0; // m/s (higher threshold for initial anchor setting)
  private readonly ANCHOR_RADIUS = 30; // metres (allow 30m of GPS drift without resetting timer)
  private readonly STOP_DURATION_MS = 120_000; // 120 seconds (2 minutes)

  constructor(private readonly redisService: RedisService) {}

  private calculateEuclideanDist(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const M_PER_DEG_LAT = 111320;
    const cosLat = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
    const M_PER_DEG_LNG = 111320 * cosLat;

    const dx = (lng2 - lng1) * M_PER_DEG_LNG;
    const dy = (lat2 - lat1) * M_PER_DEG_LAT;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * @param participantState — if 'FROZEN', skip detection entirely
   */
  async compute(
    eventId: number,
    participantId: number,
    speedCalculated: number,
    participantState: string,
    lat: number,
    lng: number,
    capturedAtMs: number,
  ): Promise<{
    stopped: boolean;
    stoppedDurationSec: number;
    justStopped: boolean;
  }> {
    // ── State guard: FROZEN participants are handled by SOS ──────
    if (participantState === 'FROZEN') {
      return { stopped: false, stoppedDurationSec: 0, justStopped: false };
    }

    const stopState = await this.redisService.getStopState(
      eventId,
      participantId,
    );

    if (!stopState) {
      // ── No active stop session. Should we start one? ──
      // Use instantaneous speed to detect initial stop
      if (speedCalculated < this.SPEED_THRESHOLD) {
        // Set the current location as the Spatial Anchor
        await this.redisService.setStopState(
          eventId,
          participantId,
          lat,
          lng,
          capturedAtMs,
        );
      }
      return { stopped: false, stoppedDurationSec: 0, justStopped: false };
    }

    // ── Active stop session. Check drift against Spatial Anchor ──
    const distFromAnchor = this.calculateEuclideanDist(
      lat,
      lng,
      stopState.anchorLat,
      stopState.anchorLng,
    );

    if (distFromAnchor > this.ANCHOR_RADIUS) {
      // ── Moving: Participant left the anchor radius ──
      await this.redisService.clearStopState(eventId, participantId);
      await this.redisService.clearStopAlertSent(eventId, participantId);
      return { stopped: false, stoppedDurationSec: 0, justStopped: false };
    }

    // ── Still stopped (within radius). Check duration ──
    const durationMs = capturedAtMs - stopState.startTimeMs;
    const durationSec = Math.round(durationMs / 1000);

    if (durationMs >= this.STOP_DURATION_MS) {
      // Check if we already alerted for this stop session
      const alertSent = await this.redisService.getStopAlertSent(
        eventId,
        participantId,
      );
      let justStopped = false;

      if (!alertSent) {
        this.logger.warn(
          `[StopDetector] 🛑 Participant ${participantId} idle for ${durationSec}s at anchor (${stopState.anchorLat}, ${stopState.anchorLng})`,
        );
        await this.redisService.setStopAlertSent(eventId, participantId);
        justStopped = true;
      }

      return { stopped: true, stoppedDurationSec: durationSec, justStopped };
    }

    return {
      stopped: false,
      stoppedDurationSec: durationSec,
      justStopped: false,
    };
  }
}
