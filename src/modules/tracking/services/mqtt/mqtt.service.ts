import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as mqtt from 'mqtt';
import { RedisService } from '../../../redis/redis.service';
import { AnalysisService } from '../../../analysis/analysis.service';
import { BatchService, LocationLogPayload } from '../batch/batch.service';
import { EventsGateway } from '../../events/events.gateway';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
    private client!: mqtt.MqttClient;
    private readonly logger = new Logger(MqttService.name);

    constructor(
        private redisService: RedisService,
        private analysisService: AnalysisService,
        private batchService: BatchService,
        private eventsGateway: EventsGateway,
        private configService: ConfigService,
    ) { }

    onModuleInit() {
        const host = this.configService.get<string>('MQTT_HOST') || 'localhost';
        const port = this.configService.get<number>('MQTT_PORT') || 1883;
        const url = `mqtt://${host}:${port}`;

        this.logger.log(`Connecting to MQTT broker at ${url}`);
        this.client = mqtt.connect(url);

        this.client.on('connect', () => {
            this.logger.log('Connected to EMQX broker');
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

    private async handleMessage(topic: string, message: Buffer) {
        try {
            // Topic structure: dashly/events/{eventId}/p/{userId}/loc
            const parts = topic.split('/');
            const eventId = parseInt(parts[2], 10);
            const userId = parseInt(parts[4], 10);

            const payload = JSON.parse(message.toString());

            // Validating required payload fields structurally
            if (!payload.lat || !payload.lng) return;

            const lat = parseFloat(payload.lat);
            const lng = parseFloat(payload.lng);
            const speed = payload.speed !== undefined ? parseFloat(payload.speed) : null;
            const battery = payload.battery !== undefined ? parseInt(payload.battery, 10) : null;
            const isOffline = payload.isOffline === true;
            const timestamp = payload.captured_at ? new Date(payload.captured_at) : new Date();

            // 1. Send to Redis (Geospatial & Status)
            await this.redisService.updateParticipantPosition(eventId, userId, lat, lng, speed, battery, isOffline);

            // 2. Broadcast via WebSockets to Event Room
            const broadcastPayload = {
                userId,
                eventId,
                lat,
                lng,
                speed,
                battery,
                isOffline,
                timestamp,
            };
            this.eventsGateway.broadcastPositionUpdate(eventId, broadcastPayload);

            // 3. Queue for DB Batch Insert
            const logObj: LocationLogPayload = {
                userId,
                latitude: lat.toString(),
                longitude: lng.toString(),
                speed: speed ? speed.toString() : null,
                isOffline,
                timestamp,
            };
            this.batchService.addLog(logObj);

            // 4. Send to Anomaly Detection Engine (The Brain)
            // Done asynchronously to not block the MQTT pipeline
            this.analysisService.detectAnomalies(eventId, userId, lat, lng, speed, timestamp).catch(e => {
                this.logger.error(`Error in Anomaly Detection for user ${userId}:`, e);
            });

        } catch (e) {
            this.logger.error('Error processing MQTT message', e);
        }
    }
}

