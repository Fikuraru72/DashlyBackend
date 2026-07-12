import { Controller, Get } from '@nestjs/common';
import { AppReleasesService } from './app-releases.service';

@Controller('app-releases')
export class AppReleasesController {
  constructor(private readonly appReleasesService: AppReleasesService) {}

  @Get('latest')
  async getLatestRelease() {
    const latest = await this.appReleasesService.getLatestRelease();
    return { success: true, data: latest };
  }
}
