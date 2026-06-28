import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq } from 'drizzle-orm';
import * as turf from '@turf/turf';
import { LineString } from 'geojson';

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private redisService: RedisService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // Dead code removed: anomaly detection is now handled by TrackingEnrichmentConsumer and its engines.
}
