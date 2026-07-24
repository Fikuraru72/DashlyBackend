import { Injectable, Logger, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Redis from 'ioredis';

import { DB_CONNECTION } from '../../../db/database.module';
import * as schema from '../../../db/schema';
import { TrackingEvent, QUEUE_TRACKING_DB } from '../../common/interfaces/tracking-event.interface';
import { TrackingStreamService } from '../../stream/tracking-stream.service';

@Injectable()
export class DbWriterConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbWriterConsumer.name);
  private worker!: Worker;
  private workerConnection!: Redis;

  constructor(
    private readonly stream: TrackingStreamService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  onModuleInit() {
    this.workerConnection = this.stream.createWorkerConnection();
    this.worker = new Worker(
      QUEUE_TRACKING_DB,
      async (job: Job<TrackingEvent>) => this.persist(job.data),
      { connection: this.workerConnection as never, concurrency: 5 },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(`DB Writer job ${job?.id} failed`, error),
    );
  }

  async onModuleDestroy() {
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
        latitude: e.intelligence?.snappedLat ?? e.lat,
        longitude: e.intelligence?.snappedLng ?? e.lng,
        altitude: e.altitude,
        speed: e.speedFromClient,
        battery: e.battery ?? null,
        distanceDelta: e.distanceDelta,
        speedCalculated: e.speedCalculated,
        isAnomaly: e.flags.isAnomaly,
        isOffline: e.flags.isOffline,
        capturedAt: new Date(e.capturedAt),
        serverReceivedAt: new Date(e.serverReceivedAt),
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
