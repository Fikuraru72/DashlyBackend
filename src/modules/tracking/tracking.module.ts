import { Module, forwardRef } from '@nestjs/common';
import { TrackingValidatorService } from './tracking-validator.service';
import { IdentityCacheService } from './identity-cache.service';
import { EventCacheService } from './event-cache.service';
import { RedisModule } from '../redis/redis.module';
import { DatabaseModule } from '../../db/database.module';
import { EventStatusScheduler } from './services/event-status.scheduler';
import { AnomalyCronService } from './services/anomaly-cron.service';
import { ShardingBroadcastService } from './services/sharding-broadcast.service';
import { IngestModule } from '../ingest/ingest.module';

@Module({
  imports: [RedisModule, DatabaseModule, forwardRef(() => IngestModule)],
  providers: [
    TrackingValidatorService,
    IdentityCacheService,
    EventCacheService,
    EventStatusScheduler,
    AnomalyCronService,
    ShardingBroadcastService,
  ],
  exports: [TrackingValidatorService, IdentityCacheService, EventCacheService],
})
export class TrackingModule {}
