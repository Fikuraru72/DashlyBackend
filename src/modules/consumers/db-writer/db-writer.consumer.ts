import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { TrackingStreamService } from '../../stream/tracking-stream.service';
import { DB_CONNECTION } from '../../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../../db/schema';
import {
  TrackingEvent,
  QUEUE_TRACKING_ENRICHED,
} from '../../common/interfaces/tracking-event.interface';
import Redis from 'ioredis';

/**
 * DbWriterConsumer — Persists enriched tracking events to PostgreSQL.
 *
 * Consumes from: tracking-events-enriched
 * Batches inserts every 3 seconds or when buffer reaches 500 items.
 * Uses onConflictDoNothing for idempotent writes.
 *
 * ⚠️  NO WebSocket, NO Redis, NO business logic.
 */
@Injectable()
export class DbWriterConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbWriterConsumer.name);
  private worker!: Worker;
  private workerConnection!: Redis;

  private buffer: TrackingEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 3000;
  private readonly MAX_BATCH_SIZE = 500;

  constructor(
    private readonly stream: TrackingStreamService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  onModuleInit() {
    this.workerConnection = this.stream.createWorkerConnection();

    this.worker = new Worker(
      QUEUE_TRACKING_ENRICHED,
      async (job: Job<TrackingEvent>) => {
        this.buffer.push(job.data);

        if (this.buffer.length >= this.MAX_BATCH_SIZE) {
          await this.flush();
        }
      },
      {
        connection: this.workerConnection,
        concurrency: 5,
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(`DB Writer job ${job?.id} failed:`, err);
    });

    // Periodic flush timer
    this.flushTimer = setInterval(() => this.flush(), this.FLUSH_INTERVAL_MS);

    this.logger.log(
      'DB Writer consumer started on queue: ' + QUEUE_TRACKING_ENRICHED,
    );
  }

  async onModuleDestroy() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush(); // Final flush
    await this.worker?.close();
    await this.workerConnection?.quit();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);

    try {
      const mapped = batch.map((e) => ({
        messageId: e.messageId,
        userId: e.userId,
        participantId: e.participantId,
        eventId: e.eventId,
        latitude: e.lat,
        longitude: e.lng,
        speed: e.speedFromClient,
        distanceDelta: e.distanceDelta,
        speedCalculated: e.speedCalculated,
        isAnomaly: e.flags.isAnomaly,
        isOffline: e.flags.isOffline,
        capturedAt: new Date(e.capturedAt),
      }));

      await this.db
        .insert(schema.locationLogs)
        .values(mapped)
        .onConflictDoNothing({ target: [schema.locationLogs.messageId] });

      this.logger.log(
        `[DB Writer] ✅ Batched ${mapped.length} location logs to PostgreSQL`,
      );
    } catch (error) {
      this.logger.error(
        `[DB Writer] ❌ Batch insert failed (${batch.length} rows):`,
        error,
      );
      // Re-add to buffer for next attempt (simple retry)
      this.buffer.unshift(...batch);
    }
  }
}
