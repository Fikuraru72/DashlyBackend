import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as mqtt from 'mqtt';
import { RedisService } from '../../../redis/redis.service';
import { AnalysisService } from '../../../analysis/analysis.service';
import { BatchService, LocationLogPayload } from '../batch/batch.service';
import { EventsGateway } from '../../events/events.gateway';
import { EventsService } from '../../../events/events.service';
import { ConfigService } from '@nestjs/config';
import { isMonitoringWindowOpen } from '../../../events/monitoring.helper';

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
    private client!: mqtt.MqttClient;
    private readonly logger = new Logger(MqttService.name);

    // Cache event data to avoid DB hits on every message
    private eventCache = new Map<number, { data: any; cachedAt: number }>();
    private readonly CACHE_TTL_MS = 10_000; // 10 seconds

    constructor(
        private redisService: RedisService,
        private analysisService: AnalysisService,
        private batchService: BatchService,
        private eventsGateway: EventsGateway,
        private eventsService: EventsService,
        private configService: ConfigService,
    ) { }

    onModuleInit() {
        const host = this.configService.get<string>('MQTT_HOST') || 'localhost';
        const port = this.configService.get<number>('MQTT_PORT') || 1883;
        const url = `mqtt://${host}:${port}`;

        this.logger.log(`Connecting to MQTT broker at ${url}`);
        this.client = mqtt.connect(url, { reconnectPeriod: 5000 });

        this.client.on('connect', () => {
            this.logger.log('Connected to Mosquitto broker');
            // Subscribe to the wildcard topic pattern
            this.client.subscribe('dashly/events/+/p/+/loc', (err) => {
                if (!err) {
                    this.logger.log('Subscribed to dashly/events/+/p/+/loc');
                } else {
                    this.logger.error('Failed to subscribe', err);
                }
            });
        });

        this.client.on('message', (topic, message) => {
            this.handleMessage(topic, message);
        });
    }

    onModuleDestroy() {
        this.client?.end();
    }

    /**
     * Get event data with short-lived cache to minimize DB hits during high-frequency MQTT flow.
     */
    private async getCachedEvent(eventId: number) {
        const cached = this.eventCache.get(eventId);
        if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
            return cached.data;
        }
        const event = await this.eventsService.getEventRaw(eventId);
        if (event) {
            this.eventCache.set(eventId, { data: event, cachedAt: Date.now() });
        }
        return event;
    }

    private async handleMessage(topic: string, message: Buffer) {
        try {
            const parts = topic.split('/');
            const eventId = parseInt(parts[2], 10);
            const userId = parseInt(parts[4], 10);

            const payload = JSON.parse(message.toString());
            
            const lat = parseFloat(payload.lat);
            const lng = parseFloat(payload.lng);
            
            if (isNaN(lat) || isNaN(lng)) return;

            const broadcastPayload = {
                userId,
                eventId,
                lat,
                lng,
                speed: parseFloat(payload.speed) || 0,
                status: payload.status || 'moving',
                battery: parseInt(payload.battery) || 100,
                timestamp: new Date()
            };

            this.logger.log(`[DUMB PIPE] Forwarding MQTT to WS -> User: ${userId}, Event: ${eventId}, [${lat}, ${lng}]`);
            this.eventsGateway.broadcastPositionUpdate(eventId, broadcastPayload);
            
            // Database logging REMOVED per dumb-pipe architecture refactor

        } catch (e) {
            this.logger.error('Error processing MQTT message', e);
        }
    }
}
