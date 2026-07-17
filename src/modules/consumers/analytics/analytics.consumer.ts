import { Injectable, Logger } from '@nestjs/common';

/**
 * AnalyticsConsumer — PLACEHOLDER
 *
 * Will eventually consume tracking-events-enriched and perform:
 *   - Off-route detection (turf.pointToLineDistance)
 *   - Stuck detection (stationary > 5 min)
 *   - Route deviation scoring
 *   - Heatmap data aggregation
 */
@Injectable()
export class AnalyticsConsumer {
  private readonly logger = new Logger(AnalyticsConsumer.name);

  onModuleInit() {
    this.logger.log('Analytics consumer registered (placeholder — no worker active)');
  }
}
