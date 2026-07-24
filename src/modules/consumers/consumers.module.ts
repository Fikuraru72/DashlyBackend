import { Module } from '@nestjs/common';
import { TrackingEnrichmentConsumer } from './enrichment/tracking-enrichment.consumer';
import { DbWriterConsumer } from './db-writer/db-writer.consumer';
import { WsPublisherConsumer } from './ws-publisher/ws-publisher.consumer';
import { EnrichedFanoutConsumer } from './fanout/enriched-fanout.consumer';
import { SosConsumer } from './sos/sos.consumer';
import { AnalyticsConsumer } from './analytics/analytics.consumer';
import { RankingConsumer } from './ranking/ranking.consumer';
import { StreamModule } from '../stream/stream.module';
import { DatabaseModule } from '../../db/database.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { RedisModule } from '../redis/redis.module';
import { EventsModule } from '../events/events.module';

// Phase 1 Intelligence
import { ProgressEngine } from './intelligence/progress.engine';
import { RankingEngine } from './intelligence/ranking.engine';
import { OffRouteEngine } from './intelligence/offroute.engine';
import { StopDetectorEngine } from './intelligence/stopdetector.engine';


@Module({
  imports: [StreamModule, DatabaseModule, WebSocketModule, RedisModule, EventsModule],
  controllers: [],
  providers: [
    TrackingEnrichmentConsumer,
    EnrichedFanoutConsumer,
    DbWriterConsumer,
    WsPublisherConsumer,
    SosConsumer,
    AnalyticsConsumer,
    RankingConsumer,
    // Intelligence Layer
    ProgressEngine,
    RankingEngine,
    OffRouteEngine,
    StopDetectorEngine,
  ],
})
export class ConsumersModule {}
