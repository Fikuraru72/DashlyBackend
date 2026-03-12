import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventStatusDto } from './dto/update-event-status.dto';
import { JoinEventDto } from './dto/join-event.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('events')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EventsController {
    constructor(private readonly eventsService: EventsService) { }

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

    @Get(':id')
    @Roles('SUPER_ADMIN', 'STAFF')
    async getEventById(@Param('id') id: string, @CurrentUser() user: any) {
        return this.eventsService.getEventById(+id, user);
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

    @Post('join')
    @Roles('PARTICIPANT')
    async joinEvent(@CurrentUser() user: any, @Body() dto: JoinEventDto) {
        return this.eventsService.joinEvent(user, dto);
    }
}
