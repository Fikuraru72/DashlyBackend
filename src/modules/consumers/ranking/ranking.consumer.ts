import { Injectable, Logger } from '@nestjs/common';

/**
 * RankingConsumer — PLACEHOLDER
 *
 * Will eventually consume tracking-events-enriched and perform:
 *   - Progress percentage calculation based on GPX route
 *   - Checkpoint crossing detection
 *   - Time efficiency calculation
 *   - Updates to the `rankings` DB table
 */
@Injectable()
export class RankingConsumer {
  private readonly logger = new Logger(RankingConsumer.name);

  onModuleInit() {
    this.logger.log(
      'Ranking consumer registered (placeholder — no worker active)',
    );
  }
}
