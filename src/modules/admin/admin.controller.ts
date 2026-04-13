import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'STAFF')
export class AdminController {
  @Get('stats')
  getStats() {
    return {
      totalEvents: 10,
      activeRunners: 34,
      systemHealth: 'ONLINE',
      brokerStatus: 'ACTIVE'
    };
  }
}
