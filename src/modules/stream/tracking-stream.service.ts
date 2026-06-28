import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, Job } from 'bullmq';
import Redis, { Redis as RedisClient } from 'ioredis';
import {
  TrackingEvent,
  QUEUE_TRACKING_RAW,
  QUEUE_TRACKING_ENRICHED,
} from '../common/interfaces/tracking-event.interface';

/**
 * TrackingStreamService — Central BullMQ event bus.
 *
 * Manages two queues:
 *   1. tracking-events-raw     — all normalised events from the Validator
 *   2. tracking-events-enriched — events that passed the enrichment filter
 *
 * Consumers register their own BullMQ Workers via this service's connection.
 */
@Injectable()
export class TrackingStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrackingStreamService.name);
  private connection!: RedisClient;
  private rawQueue!: Queue;
  private enrichedQueue!: Queue;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.connection = new Redis({
      host: this.configService.get<string>('REDIS_HOST') || 'localhost',
      port: this.configService.get<number>('REDIS_PORT') || 6379,
      maxRetriesPerRequest: null, // Required by BullMQ
    });

    this.rawQueue = new Queue(QUEUE_TRACKING_RAW, {
      connection: this.connection,
    });
    this.enrichedQueue = new Queue(QUEUE_TRACKING_ENRICHED, {
      connection: this.connection,
    });

    this.logger.log(
      `Stream initialised — queues: [${QUEUE_TRACKING_RAW}, ${QUEUE_TRACKING_ENRICHED}]`,
    );
  }

  async onModuleDestroy() {
    await this.rawQueue?.close();
    await this.enrichedQueue?.close();
    await this.connection?.quit();
  }

  // ─── Publish helpers ─────────────────────────────────────────

  /** Called by TrackingValidatorService after normalisation. */
  async publishRaw(event: TrackingEvent): Promise<void> {
    await this.rawQueue.add('location', event, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  /** Called by TrackingEnrichmentConsumer after filtering. */
  async publishEnriched(event: TrackingEvent): Promise<void> {
    await this.enrichedQueue.add('location', event, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  // ─── Connection accessor (consumers create their own Workers) ──

  /** Returns a DEDICATED Redis connection for a BullMQ Worker (must be separate from the Queue connection). */
  createWorkerConnection(): RedisClient {
    return new Redis({
      host: this.configService.get<string>('REDIS_HOST') || 'localhost',
      port: this.configService.get<number>('REDIS_PORT') || 6379,
      maxRetriesPerRequest: null,
    });
  }

  /** Queue name constants for consumers to reference. */
  get queueNames() {
    return {
      raw: QUEUE_TRACKING_RAW,
      enriched: QUEUE_TRACKING_ENRICHED,
    };
  }
}
