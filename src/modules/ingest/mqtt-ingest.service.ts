import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mqtt from 'mqtt';
import { TrackingValidatorService } from '../tracking/tracking-validator.service';
import { SosHandlerService } from './sos-handler.service';
import { StatusHandlerService } from './status-handler.service';
import { RawIngestPayload } from '../common/interfaces/tracking-event.interface';
import { IdentityCacheService } from '../tracking/identity-cache.service';

/**
 * MqttIngestService — STATELESS INGESTION LAYER.
 *
 * Responsibilities:
 *   - Connect to MQTT broker
 *   - Parse topic strings to extract eventId and userId
 *   - Parse JSON payloads safely
 *   - Basic null guards (e.g., isNaN(lat))
 *   - Route message to the appropriate handler/validator based on topic suffix
 *
 * ⚠️  NO database access. NO WebSocket emits. NO business logic.
 */
@Injectable()
export class MqttIngestService implements OnModuleInit, OnModuleDestroy {
  private client!: mqtt.MqttClient;
  private readonly logger = new Logger(MqttIngestService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly validator: TrackingValidatorService,
    private readonly sosHandler: SosHandlerService,
    private readonly statusHandler: StatusHandlerService,
    private readonly identityCache: IdentityCacheService,
  ) {}

  onModuleInit() {
    const host = this.configService.get<string>('MQTT_HOST') || 'localhost';
    const port = this.configService.get<number>('MQTT_PORT') || 1883;
    const url = `mqtt://${host}:${port}`;

    this.logger.log(`Connecting to MQTT broker at ${url}`);
    this.client = mqtt.connect(url, { reconnectPeriod: 5000 });

    this.client.on('connect', () => {
      this.logger.log('Connected to MQTT broker (Ingest Layer)');

      const topics = [
        'dashly/events/+/p/+/loc',
        'dashly/events/+/p/+/status',
        'dashly/events/+/p/+/sync',
        'dashly/events/+/p/+/sos',
      ];

      topics.forEach((t) => {
        this.client.subscribe(t, (err) => {
          if (!err) this.logger.log(`Subscribed to ${t}`);
          else this.logger.error(`Failed to subscribe to ${t}`, err);
        });
      });
    });

    this.client.on('message', (topic, message) => {
      void this.handleMessage(topic, message);
    });
  }

  onModuleDestroy() {
    this.client?.end();
  }

  /** Expose publish capability for broadcast services */
  publish(topic: string, message: string, retain = false): void {
    if (this.client && this.client.connected) {
      this.client.publish(topic, message, { qos: 0, retain });
    }
  }

  private async handleMessage(topic: string, message: Buffer) {
    try {
      const parts = topic.split('/');
      const eventId = parseInt(parts[2], 10);
      const userId = parseInt(parts[4], 10);

      if (isNaN(eventId) || isNaN(userId)) {
        this.logger.warn(`[Ingest] Invalid topic format: ${topic}`);
        return;
      }

      const participantId = await this.identityCache.resolveParticipantId(eventId, userId);
      if (!participantId) {
        this.logger.warn(`[Ingest] Participant not found for Event ${eventId}, User ${userId}`);
        return;
      }

      const payloadStr = message.toString();
      if (!payloadStr) return;

      const payload = JSON.parse(payloadStr);
      const raw: RawIngestPayload = {
        eventId,
        participantId,
        userId,
        msgId: payload.msg_id,
        lat: payload.lat,
        lng: payload.lng,
        speed: payload.speed,
        battery: payload.battery,
        capturedAt: payload.captured_at,
        status: payload.status,
      };

      // ── ROUTING ──────────────────────────────────────────────────

      if (topic.endsWith('/sos')) {
        const latNum = parseFloat(raw.lat as string);
        const lngNum = parseFloat(raw.lng as string);
        if (isNaN(latNum) || isNaN(lngNum)) {
          this.logger.warn(
            `[Ingest] Invalid coordinates for SOS: lat=${raw.lat}, lng=${raw.lng}. Dropping.`,
          );
          return;
        }
        await this.sosHandler.handle(raw);
        this.logger.warn(
          `\n\n🚨🚨🚨 [EMERGENCY] SOS PROCESSED SUCCESSFULLY FOR USER ${userId} 🚨🚨🚨\n\n`,
        );
        return;
      }

      if (topic.endsWith('/status')) {
        await this.statusHandler.handle(raw);
        return;
      }

      if (topic.endsWith('/sync')) {
        if (Array.isArray(payload) && payload.length > 0) {
          await this.validator.processSyncBatch(eventId, participantId, userId, payload);
        }
        return;
      }

      // Normal location update (/loc)
      if (topic.endsWith('/loc')) {
        if (!raw.msgId) {
          this.logger.warn(`[Ingest] Missing msg_id. Dropping.`);
          return;
        }

        const latNum = parseFloat(raw.lat as string);
        const lngNum = parseFloat(raw.lng as string);

        if (isNaN(latNum) || isNaN(lngNum)) {
          this.logger.warn(
            `[Ingest] Invalid coordinates: lat=${raw.lat}, lng=${raw.lng}. Dropping.`,
          );
          return;
        }

        await this.validator.processLocation(raw);
      }
    } catch (e) {
      this.logger.error(`[Ingest] Error processing message from topic ${topic}`, e);
    }
  }
}
