import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { DB_CONNECTION } from '../../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../../db/schema';

/**
 * RankingEngine — Pure Progress-Based Ranking (HARDENED).
 *
 * Ranking is determined 100% by physical route progress:
 *   Score = (progressPercentage × 10) + (checkpointsCompleted × 100)
 *
 * Speed is still tracked for telemetry display but does NOT affect rank.
 *
 * Hardening:
 *   - Anomaly exclusion (returns previous score unchanged)
 *   - Delta stabilization: max +50 per tick (or +150 when progress > 90%)
 *   - Backward movement penalty (-20 score)
 *
 * Uses Redis SORTED SET for O(log n) ranking updates and lookups.
 * Periodically flushes the full sorted set to PostgreSQL `rankings` table.
 */
@Injectable()
export class RankingEngine implements OnModuleInit {
  private readonly logger = new Logger(RankingEngine.name);
  private readonly flushIntervalMs = 30_000;

  private readonly TOTAL_CHECKPOINTS = 3;

  // Score stabilization (scaled to new score range 0–1300)
  private readonly MAX_DELTA_NORMAL = 50; // max +50 per tick
  private readonly MAX_DELTA_FINISH = 150; // max +150 when near finish (>90%)
  private readonly BACKWARD_PENALTY = 20; // -20 penalty for backward movement

  constructor(
    private readonly redisService: RedisService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  onModuleInit() {
    this.logger.log('Ranking engine started — Pure Progress Mode (distributed flush lock enabled)');
  }

  /**
   * Compute score based purely on route progress + checkpoints.
   * Speed is NOT factored into the ranking score.
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
      const [zeroBasedRank, totalParticipants, previousScore] = await Promise.all([
        this.redisService.getRank(eventId, participantId),
        this.redisService.getTotalRanked(eventId),
        this.redisService.getRankingScore(eventId, participantId),
      ]);
      return {
        score: previousScore ?? 0,
        rank: zeroBasedRank !== null ? zeroBasedRank + 1 : 1,
        totalParticipants,
      };
    }

    // ── 1. Speed buffer (for telemetry display only, NOT for ranking) ─
    await this.redisService.pushSpeedBuffer(participantId, rawSpeed);

    // ── 2. Pure Progress Score ──────────────────────────────────
    // Score = (progress% × 10) + (checkpoints × 100)
    // Range: 0 to 1300 (100×10 + 3×100)
    // This guarantees participant physically further on route always ranks higher.
    let newScore = progressPercentage * 10.0 + checkpointsCompleted * 100.0;

    // ── 3. Backward movement penalty ───────────────────────────
    if (backwardMovement) {
      newScore = Math.max(0, newScore - this.BACKWARD_PENALTY);
    }

    newScore = Math.round(newScore * 100) / 100;

    // ── 4. Delta stabilization (anti-cheat) ────────────────────
    const prevScore = (await this.redisService.getRankingScore(eventId, participantId)) ?? 0;

    const maxDelta = progressPercentage > 90 ? this.MAX_DELTA_FINISH : this.MAX_DELTA_NORMAL;

    if (newScore > prevScore + maxDelta) {
      newScore = Math.round((prevScore + maxDelta) * 100) / 100;
    }
    // Allow decrease without limit (backward movement, corrections)

    // ── 5. Update Redis sorted set ─────────────────────────────
    await this.redisService.updateRankingScore(eventId, participantId, newScore);
    void this.flushRankingsIfDue(eventId);

    // ── 6. Read rank ───────────────────────────────────────────
    const [zeroBasedRank, totalParticipants] = await Promise.all([
      this.redisService.getRank(eventId, participantId),
      this.redisService.getTotalRanked(eventId),
    ]);

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
