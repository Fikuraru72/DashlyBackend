import { Inject, Injectable } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { desc } from 'drizzle-orm';

@Injectable()
export class AppReleasesService {
  constructor(
    @Inject(DB_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async getLatestRelease() {
    const releases = await this.db
      .select()
      .from(schema.appReleases)
      .orderBy(desc(schema.appReleases.buildNumber))
      .limit(1);

    return releases[0] || null;
  }
}
