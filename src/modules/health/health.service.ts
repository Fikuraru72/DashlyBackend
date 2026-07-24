import { Injectable, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { DB_CONNECTION } from '../../db/database.module';
import * as schema from '../../db/schema';

@Injectable()
export class HealthService {
  constructor(@Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>) {}

  async getSync() {
    // Run a lightweight query — count rows in two core tables
    const userRows = await this.db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(schema.users);

    const eventRows = await this.db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(schema.events);

    const userCount = userRows[0]?.count ?? 0;
    const eventCount = eventRows[0]?.count ?? 0;

    return {
      status: 'OK',
      dbConnected: true,
      userCount,
      eventCount,
      serverTime: new Date().toISOString(),
    };
  }
}
