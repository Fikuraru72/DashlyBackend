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

  private async persist(event: TrackingEvent): Promise<void> {
    await this.db
      .insert(schema.locationLogs)
      .values({
        messageId: event.messageId,
        userId: event.userId,
        participantId: event.participantId,
        eventId: event.eventId,
        latitude: event.intelligence?.snappedLat ?? event.lat,
        longitude: event.intelligence?.snappedLng ?? event.lng,
        altitude: event.altitude,
        speed: event.speedFromClient,
        distanceDelta: event.distanceDelta,
        speedCalculated: event.speedCalculated,
        isAnomaly: event.flags.isAnomaly,
        isOffline: event.flags.isOffline,
        capturedAt: new Date(event.capturedAt),
      })
      .onConflictDoNothing({ target: [schema.locationLogs.messageId] });
  }
}
