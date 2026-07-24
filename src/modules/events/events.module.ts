import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { PublicEventsController } from './public-events.controller';
import { DatabaseModule } from '../../db/database.module';
import { RedisModule } from '../redis/redis.module';
import { GpxParserService } from './gpx-parser.service';
import { OsrmService } from './osrm.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, RedisModule, AuthModule],
  providers: [EventsService, GpxParserService, OsrmService],
  controllers: [EventsController, PublicEventsController],
  exports: [EventsService, GpxParserService, OsrmService],
})
export class EventsModule {}
