import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

import {
  QUEUE_TRACKING_DB,
  QUEUE_TRACKING_ENRICHED,
  QUEUE_TRACKING_WS,
  TrackingEvent,
} from '../../common/interfaces/tracking-event.interface';
import { TrackingStreamService } from '../../stream/tracking-stream.service';

const jobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

@Injectable()
export class EnrichedFanoutConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnrichedFanoutConsumer.name);
  private worker!: Worker;
  private workerConnection!: Redis;
  private queueConnection!: Redis;
  private dbQueue!: Queue;
  private wsQueue!: Queue;

  constructor(private readonly stream: TrackingStreamService) {}

  onModuleInit() {
    this.workerConnection = this.stream.createWorkerConnection();
    this.queueConnection = this.stream.createWorkerConnection();
    this.dbQueue = new Queue(QUEUE_TRACKING_DB, {
      connection: this.queueConnection as never,
    });
    this.wsQueue = new Queue(QUEUE_TRACKING_WS, {
      connection: this.queueConnection as never,
    });
    this.worker = new Worker(
      QUEUE_TRACKING_ENRICHED,
      async (job: Job<TrackingEvent>) => {
        await Promise.all([
          this.dbQueue.add('location', job.data, {
            ...jobOptions,
            jobId: job.data.messageId,
          }),
          this.wsQueue.add('location', job.data, {
            ...jobOptions,
            jobId: job.data.messageId,
          }),
        ]);
      },
      { connection: this.workerConnection as never, concurrency: 10 },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Fanout job ${job?.id} failed`, error),
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.dbQueue?.close();
    await this.wsQueue?.close();
    await this.workerConnection?.quit();
    await this.queueConnection?.quit();
  }
}
