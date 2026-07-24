import { Module, Global } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../../db/database.module';

@Global() // Global so consumers and ingest can inject EventsGateway
@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class WebSocketModule {}
