import { Logger, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { IngestModule } from './processes/ingest.module';
import { SchedulerModule } from './processes/scheduler.module';
import { WorkerModule } from './processes/worker.module';

const processes: Record<string, { module: Type<unknown>; name: string }> = {
  ingest: { module: IngestModule, name: 'MQTT ingest' },
  scheduler: { module: SchedulerModule, name: 'Scheduler' },
  worker: { module: WorkerModule, name: 'Worker' },
};

async function bootstrap() {
  const processName = process.argv[2];
  const selected = processes[processName];
  if (!selected) throw new Error(`Unknown process: ${processName}`);

  const app = await NestFactory.createApplicationContext(selected.module);
  app.enableShutdownHooks();
  Logger.log(`${selected.name} process started`, 'Bootstrap');
}

void bootstrap();
