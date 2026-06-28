import { Module } from '@nestjs/common';
import { MqttIngestService } from './mqtt-ingest.service';
import { SosHandlerService } from './sos-handler.service';
import { StatusHandlerService } from './status-handler.service';
import { TrackingModule } from '../tracking/tracking.module';
import { DatabaseModule } from '../../db/database.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [TrackingModule, DatabaseModule, RedisModule],
  providers: [MqttIngestService, SosHandlerService, StatusHandlerService],
})
export class IngestModule {}
