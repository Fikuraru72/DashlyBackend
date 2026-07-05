import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EventsService } from './events.service';
import { GpxParserService } from './gpx-parser.service';
import { OsrmService } from './osrm.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { UpdateEventStatusDto } from './dto/update-event-status.dto';
import { JoinEventDto } from './dto/join-event.dto';
import { VerifyBibDto } from './dto/verify-bib.dto';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('events')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly gpxParser: GpxParserService,
    private readonly osrmService: OsrmService,
  ) {}

  @Post('upload-gpx')
  @Roles('SUPER_ADMIN', 'STAFF')
  @UseInterceptors(FileInterceptor('file'))
  async uploadGpx(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new Error('No file provided');
    }
    const gpxString = file.buffer.toString('utf-8');
    const parsed = this.gpxParser.parseGpx(gpxString);
    const category = file.originalname?.toLowerCase().includes('cycling')
      ? 'CYCLING'
      : 'RUNNING';
    const normalized = await this.osrmService.normalizeRoute(
      category,
      parsed.geoJson,
    );

    return {
      success: true,
      data: normalized
        ? {
            ...parsed,
            geoJson: normalized.geoJson,
            totalDistanceMeters: normalized.totalDistanceMeters,
          }
        : parsed,
    };
  }

  @Post()
  @Roles('SUPER_ADMIN', 'STAFF')
  async createEvent(@CurrentUser() user: any, @Body() dto: CreateEventDto) {
    return this.eventsService.createEvent(user, dto);
  }

  @Get()
  @Roles('SUPER_ADMIN', 'STAFF')
  async getAllEvents(@CurrentUser() user: any) {
    return this.eventsService.getAllEvents(user);
  }

  @Get('my-events')
  @Roles('SUPER_ADMIN', 'STAFF', 'PARTICIPANT')
  async getMyEvents(@CurrentUser() user: any) {
    return this.eventsService.getMyEvents(user);
  }

  @Get('explore')
  @Roles('SUPER_ADMIN', 'STAFF', 'PARTICIPANT')
  async getExploreEvents() {
    return this.eventsService.getExploreEvents();
  }

  @Get(':id/live')
  @Roles('SUPER_ADMIN', 'STAFF')
  async getLivePositions(@Param('id') id: string) {
    return this.eventsService.getLivePositions(+id);
  }

  @Get(':id/participants')
  @Roles('SUPER_ADMIN', 'STAFF')
  async getParticipants(@Param('id') id: string) {
    return this.eventsService.getParticipants(+id);
  }

  @Get(':id')
  @Roles('SUPER_ADMIN', 'STAFF', 'PARTICIPANT')
  async getEventById(@Param('id') id: string, @CurrentUser() user: any) {
    const eventId = +id;
    if (isNaN(eventId)) {
      throw new BadRequestException('Invalid event ID');
    }
    return this.eventsService.getEventById(eventId, user);
  }

  @Put(':id')
  @Roles('SUPER_ADMIN', 'STAFF')
  async updateEvent(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateEventDto,
  ) {
    return this.eventsService.updateEvent(+id, user, dto);
  }

  @Put(':id/status')
  @Roles('SUPER_ADMIN', 'STAFF')
  async updateEventStatus(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateEventStatusDto,
  ) {
    return this.eventsService.updateEventStatus(+id, user, dto);
  }

  @Delete(':id')
  @Roles('SUPER_ADMIN', 'STAFF')
  async deleteEvent(@Param('id') id: string, @CurrentUser() user: any) {
    return this.eventsService.deleteEvent(+id, user);
  }

  @Post(':id/join')
  @Roles('SUPER_ADMIN', 'STAFF', 'PARTICIPANT')
  async joinEvent(@Param('id') id: string, @CurrentUser() user: any) {
    return this.eventsService.joinEvent(user, +id);
  }

  @Post(':id/verify-bib')
  @Roles('SUPER_ADMIN', 'STAFF', 'PARTICIPANT')
  async verifyBib(@Param('id') id: string, @Body() dto: VerifyBibDto, @CurrentUser() user: any) {
    return this.eventsService.verifyBib(user, +id, dto.bibNumber);
  }

  @Post('join-via-token')
  @Roles('SUPER_ADMIN', 'STAFF', 'PARTICIPANT')
  async joinEventViaToken(@Body() dto: JoinEventDto, @CurrentUser() user: any) {
    console.log('[DEBUG] join-via-token requested by user:', user);
    return this.eventsService.joinEventViaToken(user, dto.token);
  }



  @Get(':id/positions')
  @Roles('SUPER_ADMIN', 'STAFF')
  async getEventPositions(@Param('id') id: string) {
    return this.eventsService.getEventPositions(+id);
  }

  @Put(':eventId/participants/:participantId/state')
  @Roles('SUPER_ADMIN', 'STAFF')
  async updateParticipantState(
    @Param('eventId') eventId: string,
    @Param('participantId') participantId: string,
    @Body() body: { state: string },
  ) {
    return this.eventsService.updateParticipantState(
      +eventId,
      +participantId,
      body.state,
    );
  }
}
