import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DB_CONNECTION } from '../../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../../db/schema';
import { inArray, eq } from 'drizzle-orm';
import {
  getMonitoringWindow,
  EventForMonitoring,
} from '../../events/monitoring.helper';
import { EventsGateway } from '../../websocket/events.gateway';

@Injectable()
export class EventStatusScheduler {
  private readonly logger = new Logger(EventStatusScheduler.name);

  constructor(
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    private readonly eventsGateway: EventsGateway,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron() {
    this.logger.debug('Running auto race start/end check...');

    try {
      // Fetch events that are IDLE or START
      const activeEvents = await this.db.query.events.findMany({
        where: inArray(schema.events.status, ['IDLE', 'START']),
      });

      for (const event of activeEvents) {
        // Map to EventForMonitoring structure
        const eventForMonitoring: EventForMonitoring = {
          startTime: event.startTime,
          endTime: event.endTime,
          monitoringStartOffset: event.monitoringStartOffset,
          monitoringEndOffset: event.monitoringEndOffset,
          status: event.status,
        };

        const window = getMonitoringWindow(eventForMonitoring);
        if (!window) continue;

        const now = new Date();

        // Check if we need to START the event
        if (event.status === 'IDLE' && now >= window.actualStart) {
          await this.db
            .update(schema.events)
            .set({ status: 'START' })
            .where(eq(schema.events.id, event.id));

          this.eventsGateway.broadcastEventStatus(event.id, 'START');
          this.logger.log(
            `Event ${event.id} automatically changed status to START`,
          );
        }

        // Check if we need to FINISH the event
        if (event.status === 'START' && now >= window.actualEnd) {
          await this.db
            .update(schema.events)
            .set({ status: 'FINISHED' })
            .where(eq(schema.events.id, event.id));

          this.eventsGateway.broadcastEventStatus(event.id, 'FINISHED');
          this.logger.log(
            `Event ${event.id} automatically changed status to FINISHED`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Error executing event status cron job', error);
    }
  }
}
