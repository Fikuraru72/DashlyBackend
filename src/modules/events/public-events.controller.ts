import { Controller, Get, Post, Param, BadRequestException, UseGuards, Body } from '@nestjs/common';
import { PublicRegisterDto } from './dto/public-register.dto';
import { EventsService } from './events.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('public-events')
export class PublicEventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  async getPublicEvents() {
    return this.eventsService.getPublicEvents();
  }

  @Get(':id')
  async getPublicEventById(@Param('id') id: string) {
    const eventId = +id;
    if (isNaN(eventId)) {
      throw new BadRequestException('Invalid event ID');
    }
    return this.eventsService.getPublicEventById(eventId);
  }

  @Post(':id/register')
  async registerForEvent(@Param('id') id: string, @Body() dto: PublicRegisterDto) {
    const eventId = +id;
    if (isNaN(eventId)) {
      throw new BadRequestException('Invalid event ID');
    }
    return this.eventsService.publicRegisterEvent(dto, eventId);
  }

  @Get(':id/live')
  async getLivePositions(@Param('id') id: string) {
    const eventId = +id;
    if (isNaN(eventId)) {
      throw new BadRequestException('Invalid event ID');
    }
    return this.eventsService.getLivePositions(eventId);
  }

  @Get(':id/path-history')
  async getEventPathHistory(@Param('id') id: string) {
    const eventId = +id;
    if (isNaN(eventId)) {
      throw new BadRequestException('Invalid event ID');
    }
    return this.eventsService.getEventPathHistory(eventId);
  }

  @Get(':id/participants')
  async getPublicParticipants(@Param('id') id: string) {
    const eventId = +id;
    if (isNaN(eventId)) {
      throw new BadRequestException('Invalid event ID');
    }
    return this.eventsService.getPublicParticipants(eventId);
  }

  @Get(':id/ticket')
  @UseGuards(JwtAuthGuard)
  async getEventTicket(@Param('id') id: string, @CurrentUser() user: any) {
    const eventId = +id;
    if (isNaN(eventId)) {
      throw new BadRequestException('Invalid event ID');
    }
    return this.eventsService.getParticipantTicket(user.id, eventId);
  }
}
