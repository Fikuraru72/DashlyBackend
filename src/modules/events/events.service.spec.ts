import { Test, TestingModule } from '@nestjs/testing';
import { EventsService } from './events.service';
import { DB_CONNECTION } from '../../db/database.module';
import { RedisService } from '../redis/redis.service';
import { OsrmService } from './osrm.service';
import { JwtService } from '@nestjs/jwt';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import * as schema from '../../db/schema';
import * as helper from './monitoring.helper';

jest.mock('./monitoring.helper', () => ({
  getMonitoringWindow: jest
    .fn()
    .mockReturnValue({ start: new Date(), end: new Date() }),
  isMonitoringWindowOpen: jest.fn(),
}));

describe('EventsService', () => {
  let service: EventsService;
  let dbMock: any;
  let redisMock: any;
  let osrmMock: any;

  beforeEach(async () => {
    dbMock = {
      query: {
        events: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        eventStaff: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        eventParticipants: {
          findFirst: jest.fn(),
        },
      },
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      transaction: jest.fn((cb) => cb(dbMock)),
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
    };

    redisMock = {
      getAllParticipantPositions: jest.fn(),
    };
    osrmMock = {
      normalizeRoute: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: DB_CONNECTION, useValue: dbMock },
        { provide: RedisService, useValue: redisMock },
        { provide: JwtService, useValue: { sign: jest.fn() } },
        { provide: OsrmService, useValue: osrmMock },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getEventById', () => {
    it('should throw NotFoundException if event not found', async () => {
      dbMock.query.events.findFirst.mockResolvedValue(null);
      await expect(
        service.getEventById(1, { id: 1, role: 'PARTICIPANT' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if STAFF is not assigned', async () => {
      dbMock.query.events.findFirst.mockResolvedValue({ id: 1, name: 'Event' });
      dbMock.query.eventStaff.findFirst.mockResolvedValue(null);

      await expect(
        service.getEventById(1, { id: 2, role: 'STAFF' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return event details for PARTICIPANT', async () => {
      dbMock.query.events.findFirst.mockResolvedValue({ id: 1, name: 'Event' });

      const result = await service.getEventById(1, {
        id: 1,
        role: 'PARTICIPANT',
      });
      expect(result.success).toBe(true);
      expect(result.data.name).toBe('Event');
    });
  });

  describe('updateEventStatus', () => {
    it('should throw BadRequestException if starting but window is closed', async () => {
      dbMock.query.events.findFirst.mockResolvedValue({
        id: 1,
        name: 'Event',
        status: 'IDLE',
      });
      (helper.isMonitoringWindowOpen as jest.Mock).mockReturnValue(false);

      await expect(
        service.updateEventStatus(
          1,
          { id: 1, role: 'SUPER_ADMIN' },
          { status: 'LIVE' },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should update status to START if window is open', async () => {
      dbMock.query.events.findFirst.mockResolvedValue({
        id: 1,
        name: 'Event',
        status: 'IDLE',
      });
      (helper.isMonitoringWindowOpen as jest.Mock).mockReturnValue(true);
      dbMock.update.mockReturnThis();
      dbMock.set.mockReturnThis();
      dbMock.where.mockReturnThis();
      dbMock.returning.mockResolvedValue([{ id: 1, status: 'START' }]);

      const result = await service.updateEventStatus(
        1,
        { id: 1, role: 'SUPER_ADMIN' },
        { status: 'START' },
      );
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('START');
    });
  });

  describe('joinEventViaToken', () => {
    it('should throw NotFoundException on invalid token', async () => {
      dbMock.query.events.findFirst.mockResolvedValue(null);
      await expect(
        service.joinEventViaToken({ id: 1 }, 'INVALID'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if event is FINISHED', async () => {
      dbMock.query.events.findFirst.mockResolvedValue({
        id: 1,
        status: 'FINISHED',
      });
      await expect(
        service.joinEventViaToken({ id: 1 }, 'VALID'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException if capacity reached', async () => {
      dbMock.query.events.findFirst.mockResolvedValue({
        id: 1,
        currentCount: 10,
        maxParticipants: 10,
      });
      await expect(
        service.joinEventViaToken({ id: 1 }, 'VALID'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should join event successfully', async () => {
      dbMock.query.events.findFirst.mockResolvedValue({
        id: 1,
        currentCount: 5,
        maxParticipants: 10,
        status: 'IDLE',
      });
      dbMock.query.eventParticipants.findFirst.mockResolvedValue(null); // Not joined yet

      dbMock.insert.mockReturnThis();
      dbMock.values.mockReturnThis();
      dbMock.update.mockReturnThis();
      dbMock.set.mockReturnThis();
      dbMock.where.mockReturnThis();
      dbMock.returning.mockResolvedValue([{ id: 1, currentCount: 6 }]);

      const result = await service.joinEventViaToken({ id: 1 }, 'VALID');
      expect(result.success).toBe(true);
      expect(result.data.eventId).toBe(1);
    });
  });
});
