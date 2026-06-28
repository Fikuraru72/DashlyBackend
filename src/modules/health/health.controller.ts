import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** GET /health/sync — No auth required. Tests DB + returns server time. */
  @Get('sync')
  async sync() {
    return this.healthService.getSync();
  }
}
