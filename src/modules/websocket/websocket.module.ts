import { Module, Global } from '@nestjs/common';
import { EventsGateway } from './events.gateway';

@Global() // Global so consumers and ingest can inject EventsGateway
@Module({
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class WebSocketModule {}
