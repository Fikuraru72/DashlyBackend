import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../db/database.module';
import { AuthModule } from '../modules/auth/auth.module';
import { ConsumersModule } from '../modules/consumers/consumers.module';
import { RedisModule } from '../modules/redis/redis.module';
import { StreamModule } from '../modules/stream/stream.module';
import { WebSocketModule } from '../modules/websocket/websocket.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    RedisModule,
    StreamModule,
    WebSocketModule,
    ConsumersModule,
  ],
})
export class WorkerModule {}
