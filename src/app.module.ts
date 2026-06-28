import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './db/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { EventsModule } from './modules/events/events.module';
import { RedisModule } from './modules/redis/redis.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { HealthModule } from './modules/health/health.module';
import { TokensModule } from './modules/tokens/tokens.module';
import { AdminModule } from './modules/admin/admin.module';
import { UsersModule } from './modules/users/users.module';
import { RolesModule } from './modules/roles/roles.module';

import { IngestModule } from './modules/ingest/ingest.module';
import { StreamModule } from './modules/stream/stream.module';
import { ConsumersModule } from './modules/consumers/consumers.module';
import { WebSocketModule } from './modules/websocket/websocket.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    EventsModule,
    RedisModule,
    AnalysisModule,
    TrackingModule,
    HealthModule,
    TokensModule,
    AdminModule,
    UsersModule,
    RolesModule,
    IngestModule,
    StreamModule,
    ConsumersModule,
    WebSocketModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
