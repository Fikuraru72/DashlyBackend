import { Module, Global } from '@nestjs/common';
import { TrackingStreamService } from './tracking-stream.service';

@Global() // Global so every consumer module can inject it without explicit imports
@Module({
  providers: [TrackingStreamService],
  exports: [TrackingStreamService],
})
export class StreamModule {}
