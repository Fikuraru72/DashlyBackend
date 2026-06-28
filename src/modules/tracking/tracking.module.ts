import { Module } from '@nestjs/common';
import { TrackingValidatorService } from './tracking-validator.service';
import { IdentityCacheService } from './identity-cache.service';
import { EventCacheService } from './event-cache.service';
import { RedisModule } from '../redis/redis.module';
import { DatabaseModule } from '../../db/database.module';
import { EventStatusScheduler } from './services/event-status.scheduler';
import { AnomalyCronService } from './services/anomaly-cron.service';

@Module({
  imports: [RedisModule, DatabaseModule],
  providers: [
    TrackingValidatorService,
    IdentityCacheService,
    EventCacheService,
    EventStatusScheduler,
    AnomalyCronService,
  ],
  exports: [TrackingValidatorService, IdentityCacheService, EventCacheService],
})
export class TrackingModule {}
