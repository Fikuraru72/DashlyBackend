import { Injectable, Logger } from '@nestjs/common';

/**
 * SosConsumer — PLACEHOLDER for Audit Logging
 *
 * NOTE: The actual SOS action (DB state mutation + WS emit) happens
 * synchronously in the ingest layer (SosHandlerService) for near-zero latency.
 *
 * This consumer will eventually process SOS events from a queue to write
 * audit logs or trigger external integrations (e.g., SMS alerts).
 */
@Injectable()
export class SosConsumer {
  private readonly logger = new Logger(SosConsumer.name);

  onModuleInit() {
    this.logger.log('SOS audit consumer registered (placeholder — no worker active)');
  }
}
