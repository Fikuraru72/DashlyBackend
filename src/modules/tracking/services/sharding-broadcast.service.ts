import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { MqttIngestService } from '../../ingest/mqtt-ingest.service';

/**
 * ShardingBroadcastService
 *
 * Runs a periodic task (every 10 seconds) that aggregates participant distances
 * and publishes a proximity-sharded payload to each participant's private MQTT topic:
 * `dashly/events/{eventId}/p/{userId}/distances`
 */
@Injectable()
export class ShardingBroadcastService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShardingBroadcastService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly BROADCAST_INTERVAL_MS = 10_000; // 10 seconds

  constructor(
    private readonly redisService: RedisService,
    private readonly mqttIngestService: MqttIngestService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.broadcastProximityDistances(), this.BROADCAST_INTERVAL_MS);
    this.logger.log('Sharding Broadcast Service initialized (Interval: 10s)');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async broadcastProximityDistances(): Promise<void> {
    try {
      // Find active event keys in Redis matching ranking:*
      const keys = await this.redisService['redisClient'].keys('ranking:*');
      if (!keys || keys.length === 0) return;

      for (const key of keys) {
        const eventId = parseInt(key.replace('ranking:', ''), 10);
        if (isNaN(eventId)) continue;

        const rankings = await this.redisService.getAllRankings(eventId);
        if (!rankings || rankings.length === 0) continue;

        const totalParticipants = rankings.length;

        // Loop through each participant and generate custom sharded payload
        for (let i = 0; i < rankings.length; i++) {
          const target = rankings[i];
          const targetRank = i + 1;

          // Top 3 runners
          const top3 = rankings.slice(0, Math.min(3, rankings.length));
          // 5 runners ahead
          const ahead = rankings.slice(Math.max(0, i - 5), i);
          // 5 runners behind
          const behind = rankings.slice(i + 1, Math.min(rankings.length, i + 6));

          // Combine unique entries
          const map = new Map<number, { participantId: number; score: number; rank: number }>();

          top3.forEach((r) => {
            const rRank = rankings.indexOf(r) + 1;
            map.set(r.participantId, {
              participantId: r.participantId,
              score: r.score,
              rank: rRank,
            });
          });
          ahead.forEach((r) => {
            const rRank = rankings.indexOf(r) + 1;
            map.set(r.participantId, {
              participantId: r.participantId,
              score: r.score,
              rank: rRank,
            });
          });
          behind.forEach((r) => {
            const rRank = rankings.indexOf(r) + 1;
            map.set(r.participantId, {
              participantId: r.participantId,
              score: r.score,
              rank: rRank,
            });
          });

          // Convert to lightweight array
          const otherRunners = Array.from(map.values()).map((item) => ({
            id: item.participantId,
            d: Math.round(item.score * 100) / 100, // round to 2 decimal places
            r: item.rank,
          }));

          const payload = {
            rank: targetRank,
            total: totalParticipants,
            runners: otherRunners,
          };

          // Fetch userId to get target MQTT topic
          const stats = await this.redisService.getParticipantStats(target.participantId);
          const userIdStr = stats.userId || target.participantId.toString();

          const topic = `dashly/events/${eventId}/p/${userIdStr}/distances`;
          this.mqttIngestService.publish(topic, JSON.stringify(payload));
        }
      }
    } catch (err) {
      this.logger.error('Error during broadcastProximityDistances', err);
    }
  }
}
