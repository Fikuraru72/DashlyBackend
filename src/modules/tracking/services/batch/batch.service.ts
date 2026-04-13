import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DB_CONNECTION } from '../../../../../src/db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../../../../src/db/schema';

export interface LocationLogPayload {
    userId: number;
    eventId: number;
    latitude: number;
    longitude: number;
    speed: number | null;
    isOffline: boolean;
    timestamp: Date;
}

@Injectable()
export class BatchService {
    private readonly logger = new Logger(BatchService.name);
    private logQueue: LocationLogPayload[] = [];

    constructor(
        @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    ) { }

    addLog(log: LocationLogPayload) {
        this.logQueue.push(log);
    }

    @Cron(CronExpression.EVERY_10_SECONDS)
    async flushLogs() {
        if (this.logQueue.length === 0) return;

        // Copy and clear the queue atomically
        const logsToInsert = [...this.logQueue];
        this.logQueue = [];

        try {
            await this.db.insert(schema.locationLogs).values(logsToInsert);
            this.logger.log(`Batched ${logsToInsert.length} location logs to PostgreSQL`);
        } catch (error) {
            this.logger.error('Failed to batch insert location logs', error);
            // Optional: push them back to the queue to retry
            // this.logQueue.unshift(...logsToInsert); 
        }
    }
}
