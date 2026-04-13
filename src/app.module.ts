import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
