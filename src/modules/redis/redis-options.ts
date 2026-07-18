import { ConfigService } from '@nestjs/config';
import { RedisOptions } from 'ioredis';

export function getRedisOptions(config: ConfigService): RedisOptions {
  return {
    host: config.get<string>('REDIS_HOST') || 'localhost',
    port: config.get<number>('REDIS_PORT') || 6379,
    password: config.get<string>('REDIS_PASSWORD') || undefined,
  };
}
