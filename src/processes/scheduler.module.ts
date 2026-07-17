import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { DatabaseModule } from '../db/database.module';
import { AuthModule } from '../modules/auth/auth.module';
import { RedisModule } from '../modules/redis/redis.module';
import { EventStatusScheduler } from '../modules/tracking/services/event-status.scheduler';
import { WebSocketModule } from '../modules/websocket/websocket.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    RedisModule,
    WebSocketModule,
  ],
  providers: [EventStatusScheduler],
})
export class SchedulerModule {}
