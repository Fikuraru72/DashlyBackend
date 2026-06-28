import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { TrackingStreamService } from '../../stream/tracking-stream.service';
import { EventsGateway } from '../../websocket/events.gateway';
import {
  TrackingEvent,
  QUEUE_TRACKING_ENRICHED,
} from '../../common/interfaces/tracking-event.interface';
import Redis from 'ioredis';

/**
 * WsPublisherConsumer — Emits enriched events to dashboard via WebSocket.
 *
 * Consumes from: tracking-events-enriched
 *
 * Emits:
 *   - position_update (VALID events → buffered by EventsGateway)
 *   - anomaly_detected (ANOMALY events)
 *   - sync_batch (SYNC events)
 *
 * Skips:
 *   - LATE events (out-of-order → persisted by DB writer, not shown live)
 *
 * ⚠️  NO DB access, NO business logic, NO state mutation.
 */
@Injectable()
export class WsPublisherConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsPublisherConsumer.name);
  private worker!: Worker;
  private workerConnection!: Redis;

  constructor(
    private readonly stream: TrackingStreamService,
    private readonly gateway: EventsGateway,
  ) {}

  onModuleInit() {
    this.workerConnection = this.stream.createWorkerConnection();

    this.worker = new Worker(
      QUEUE_TRACKING_ENRICHED,
      async (job: Job<TrackingEvent>) => {
        this.process(job.data);
      },
      {
        connection: this.workerConnection,
        concurrency: 20, // Non-blocking socket emits
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(`WS Publisher job ${job?.id} failed:`, err);
    });

    this.logger.log(
      'WS Publisher consumer started on queue: ' + QUEUE_TRACKING_ENRICHED,
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.workerConnection?.quit();
  }

  private process(event: TrackingEvent): void {
    const { eventId, gatekeeperAction } = event;

    switch (gatekeeperAction) {
      case 'VALID':
        this.gateway.broadcastPositionUpdate(eventId, {
          participantId: event.participantId,
          userId: event.userId,
          eventId,
          lat: event.lat,
          lng: event.lng,
          speed: event.speedCalculated ?? event.speedFromClient,
          status: event.clientStatus,
          state: event.intelligence?.participantState || 'TRACKING',
          isOffline: event.flags?.isOffline || false,
          battery: event.battery,
          timestamp: event.capturedAt,
        });
        break;

      case 'ANOMALY':
        this.gateway.broadcastAnomalyDetected(eventId, {
          participantId: event.participantId,
          userId: event.userId,
          type: 'TELEPORT',
          lat: event.lat,
          lng: event.lng,
          speed: event.speedCalculated,
          timestamp: event.capturedAt,
        });
        break;

      case 'SYNC':
        this.gateway.broadcastSyncBatch(eventId, event.userId, [
          { lat: event.lat, lng: event.lng, speed: event.speedFromClient },
        ]);
        break;

      case 'LATE':
        // Skip — late packets go to DB only, not broadcast
        break;
    }
  }
}
