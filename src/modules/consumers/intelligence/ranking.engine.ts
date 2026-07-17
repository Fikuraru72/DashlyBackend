import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { DB_CONNECTION } from '../../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../../db/schema';

/**
 * RankingEngine — Real-time hybrid scoring + ranking (HARDENED).
 *
 * Hardening additions over Phase 1:
 *   - Speed smoothing via rolling 5-sample average
 *   - Speed clamping (Running: 8 m/s, Cycling: 20 m/s)
 *   - Anomaly exclusion (returns previous score unchanged)
 *   - Delta stabilization: max +5% per tick (or +15% when progress > 90%)
 *   - Backward movement penalty (-2% score)
 *
 * Uses Redis SORTED SET for O(log n) ranking updates and lookups.
 * Periodically flushes the full sorted set to PostgreSQL `rankings` table.
 */
@Injectable()
export class RankingEngine implements OnModuleInit {
  private readonly logger = new Logger(RankingEngine.name);
  private readonly flushIntervalMs = 30_000;

  // Speed clamping thresholds (hardened)
  private readonly MAX_SPEED_RUNNING = 8; // m/s
  private readonly MAX_SPEED_CYCLING = 20; // m/s
  private readonly TOTAL_CHECKPOINTS = 3;

  // Score stabilization
  private readonly MAX_DELTA_NORMAL = 5; // max +5% per tick
  private readonly MAX_DELTA_FINISH = 15; // max +15% when near finish (>90%)
  private readonly BACKWARD_PENALTY = 2; // -2% penalty for backward movement

  constructor(
    private readonly redisService: RedisService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  onModuleInit() {
    this.logger.log('Ranking engine started (distributed flush lock enabled)');
  }

  /**
   * Compute the hybrid score with anti-cheat protections.
   *
   * @param isAnomaly   — if true, skip scoring entirely (return previous)
   * @param backwardMovement — if true, apply ranking penalty
   */
  async compute(
    eventId: number,
    participantId: number,
    progressPercentage: number,
    rawSpeed: number,
    checkpointsCompleted: number,
    eventCategory: string,
    isAnomaly: boolean = false,
    backwardMovement: boolean = false,
  ): Promise<{ score: number; rank: number; totalParticipants: number }> {
    // ── Anomaly exclusion: return previous score unchanged ──────
    if (isAnomaly) {
      const zeroBasedRank = await this.redisService.getRank(eventId, participantId);
      const totalParticipants = await this.redisService.getTotalRanked(eventId);
      // Read previous score from sorted set
      const allRankings = await this.redisService.getAllRankings(eventId);
      const prev = allRankings.find((r) => r.participantId === participantId);
      return {
        score: prev?.score ?? 0,
        rank: zeroBasedRank !== null ? zeroBasedRank + 1 : 1,
        totalParticipants,
      };
    }

    // ── 1. Speed smoothing: push to buffer, compute rolling avg ─
    await this.redisService.pushSpeedBuffer(participantId, rawSpeed);
    const speedBuffer = await this.redisService.getSpeedBuffer(participantId);
    let smoothedSpeed = rawSpeed;
    if (speedBuffer.length > 0) {
      smoothedSpeed = speedBuffer.reduce((a, b) => a + b, 0) / speedBuffer.length;
    }

    // ── 2. Speed clamping ──────────────────────────────────────
    const maxSpeed = eventCategory === 'CYCLING' ? this.MAX_SPEED_CYCLING : this.MAX_SPEED_RUNNING;
    const clampedSpeed = Math.min(smoothedSpeed, maxSpeed);

    // ── 3. Normalize speed (0–100 scale) ───────────────────────
    const normalizedSpeed = (clampedSpeed / maxSpeed) * 100;

    // ── 4. Normalize checkpoint completion (0–100 scale) ───────
    const checkpointCompletion = (checkpointsCompleted / this.TOTAL_CHECKPOINTS) * 100;

    // ── 5. Hybrid score ────────────────────────────────────────
    let newScore = progressPercentage * 0.7 + normalizedSpeed * 0.2 + checkpointCompletion * 0.1;

    // ── 6. Backward movement penalty ───────────────────────────
    if (backwardMovement) {
      newScore = Math.max(0, newScore - this.BACKWARD_PENALTY);
    }

    newScore = Math.round(newScore * 100) / 100;

    // ── 7. Delta stabilization (anti-cheat) ────────────────────
    // Read previous score
    const allRankings = await this.redisService.getAllRankings(eventId);
    const prevEntry = allRankings.find((r) => r.participantId === participantId);
    const prevScore = prevEntry?.score ?? 0;

    const maxDelta = progressPercentage > 90 ? this.MAX_DELTA_FINISH : this.MAX_DELTA_NORMAL;

    if (newScore > prevScore + maxDelta) {
      newScore = Math.round((prevScore + maxDelta) * 100) / 100;
    }
    // Allow decrease without limit (backward movement, corrections)

    // ── 8. Update Redis sorted set ─────────────────────────────
    await this.redisService.updateRankingScore(eventId, participantId, newScore);
    void this.flushRankingsIfDue(eventId);

    // ── 9. Read rank ───────────────────────────────────────────
    const zeroBasedRank = await this.redisService.getRank(eventId, participantId);
    const totalParticipants = await this.redisService.getTotalRanked(eventId);

    return {
      score: newScore,
      rank: zeroBasedRank !== null ? zeroBasedRank + 1 : 1,
      totalParticipants,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  PERIODIC DB FLUSH
  // ═══════════════════════════════════════════════════════════════
  private async flushRankingsIfDue(eventId: number): Promise<void> {
    const lockKey = `ranking_flush:${eventId}`;
    if (!(await this.redisService.acquireLock(lockKey, this.flushIntervalMs))) return;
    try {
      await this.flushRankingsForEvent(eventId);
    } catch (err) {
      this.logger.error(`Failed to flush rankings for event ${eventId}`, err);
      await this.redisService.releaseLock(lockKey);
    }
  }

  private async flushRankingsForEvent(eventId: number): Promise<void> {
    const rankings = await this.redisService.getAllRankings(eventId);
    if (rankings.length === 0) return;

    for (const { participantId, score } of rankings) {
      const progressState = await this.redisService.getProgressState(eventId, participantId);
      const progressPct = progressState.progress ? parseFloat(progressState.progress) : 0;
      const checkpoints = progressState.checkpointsCompleted
        ? parseInt(progressState.checkpointsCompleted, 10)
        : 0;

      // Fetch actual userId for this participantId
      const [participantRow] = await this.db
        .select({ userId: schema.eventParticipants.userId })
        .from(schema.eventParticipants)
        .where(eq(schema.eventParticipants.id, participantId));

      if (!participantRow) continue;

      await this.db
        .insert(schema.rankings)
        .values({
          eventId,
          userId: participantRow.userId as number,
          participantId,
          progressPercentage: progressPct,
          checkpointsCompleted: checkpoints,
          timeEfficiency: score,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.rankings.eventId, schema.rankings.participantId],
          set: {
            progressPercentage: progressPct,
            checkpointsCompleted: checkpoints,
            timeEfficiency: score,
            updatedAt: new Date(),
          },
        });
    }

    this.logger.log(`[Ranking] 💾 Flushed ${rankings.length} rankings for event ${eventId}`);
  }
}
