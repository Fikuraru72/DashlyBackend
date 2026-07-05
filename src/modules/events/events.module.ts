import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { PublicEventsController } from './public-events.controller';
import { DatabaseModule } from '../../db/database.module';
import { RedisModule } from '../redis/redis.module';
import { GpxParserService } from './gpx-parser.service';
import { OsrmService } from './osrm.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    DatabaseModule, 
    RedisModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') || 'default_secret',
        signOptions: { expiresIn: '1d' }, // QR payload validity or can be longer
      }),
    }),
  ],
  providers: [EventsService, GpxParserService, OsrmService],
  controllers: [EventsController, PublicEventsController],
  exports: [EventsService, GpxParserService],
})
export class EventsModule {}
