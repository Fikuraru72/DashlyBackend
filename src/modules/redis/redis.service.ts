import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
    private redisClient!: Redis;

    constructor(private configService: ConfigService) { }

    onModuleInit() {
        this.redisClient = new Redis({
            host: this.configService.get<string>('REDIS_HOST') || 'localhost',
            port: this.configService.get<number>('REDIS_PORT') || 6379,
        });
    }

    onModuleDestroy() {
        this.redisClient.quit();
    }

    async updateParticipantPosition(
        eventId: number,
        userId: number,
        lat: number,
        lng: number,
        speed: number | null,
        battery: number | null,
        isOffline: boolean,
    ) {
        const geoKey = `current_positions:${eventId}`;
        const statsKey = `participant_stats:${userId}`;

        const pipeline = this.redisClient.pipeline();

        // 1. Update Geospatial position
        pipeline.geoadd(geoKey, lng, lat, userId.toString());

        // 2. Update Metadata map
        pipeline.hset(statsKey, {
            lat: lat.toString(),
            lng: lng.toString(),
            speed: speed ? speed.toString() : '0',
            battery: battery ? battery.toString() : '100',
            isOffline: isOffline ? 'true' : 'false',
            last_seen: new Date().toISOString(),
        });

        // 3. Set expiration for metadata (e.g., ghost timeout 60 seconds)
        pipeline.expire(statsKey, 60);

        // 4. (Optional) Set expiration for the whole event geo map
        // We update it so it stays alive while people send data
        pipeline.expire(geoKey, 86400); // 1 day

        await pipeline.exec();
    }

    async getParticipantStats(userId: number) {
        const statsKey = `participant_stats:${userId}`;
        return this.redisClient.hgetall(statsKey);
    }

    async getPreviousPosition(eventId: number, userId: number): Promise<{ lat: number, lng: number } | null> {
        const geoKey = `current_positions:${eventId}`;
        const pos = await this.redisClient.geopos(geoKey, userId.toString());
        if (pos && pos[0]) {
            return {
                lng: parseFloat(pos[0][0]),
                lat: parseFloat(pos[0][1])
            };
        }
        return null;
    }
}
