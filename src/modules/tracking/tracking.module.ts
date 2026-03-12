import { Module } from '@nestjs/common';
import { MqttService } from './services/mqtt/mqtt.service';
import { BatchService } from './services/batch/batch.service';
import { EventsGateway } from './events/events.gateway';
import { RedisModule } from '../redis/redis.module';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [RedisModule, AnalysisModule],
  providers: [MqttService, BatchService, EventsGateway]
})
export class TrackingModule { }
