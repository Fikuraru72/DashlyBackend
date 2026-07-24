import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { DB_CONNECTION } from '../../db/database.module';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

vi.mock('bcrypt');

describe('AuthService', () => {
  let service: AuthService;
  let dbMock: any;
  let jwtServiceMock: any;

  beforeEach(async () => {
    dbMock = {
      query: {
        users: {
          findFirst: vi.fn(),
        },
        roles: {
          findFirst: vi.fn(),
        },
      },
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
    };

    jwtServiceMock = {
      sign: vi.fn().mockReturnValue('mocked-token'),
      verify: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DB_CONNECTION, useValue: dbMock },
        { provide: JwtService, useValue: jwtServiceMock },
        {
          provide: ConfigService,
          useValue: { getOrThrow: vi.fn().mockReturnValue('client-id') },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('register', () => {
    it('should throw ConflictException if email is already in use', async () => {
      dbMock.query.users.findFirst.mockResolvedValue({
        id: 1,
        email: 'test@test.com',
      });

      await expect(
        service.register({
          name: 'Test',
          email: 'test@test.com',
          password: 'password',
          phone: '123',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should register a new user successfully', async () => {
      dbMock.query.users.findFirst.mockResolvedValue(null);
      dbMock.query.roles.findFirst.mockResolvedValue({
        id: 2,
        name: 'PARTICIPANT',
      });
      vi.mocked(bcrypt.hash).mockImplementation(async () => 'hashed-password');

      dbMock.insert.mockReturnThis();
      dbMock.values.mockReturnThis();
      dbMock.returning.mockResolvedValue([{ id: 1, email: 'new@test.com', name: 'New User' }]);

      const result = await service.register({
        name: 'New User',
        email: 'new@test.com',
        password: 'password',
        phone: '123',
      });

      expect(bcrypt.hash).toHaveBeenCalledWith('password', 10);
      expect(result.accessToken).toBe('mocked-token');
      expect(result.user.email).toBe('new@test.com');
      expect(result.user.role).toBe('PARTICIPANT');
    });
  });

  describe('login', () => {
    it('should throw UnauthorizedException on invalid email', async () => {
      dbMock.query.users.findFirst.mockResolvedValue(null);

      await expect(
        service.login({ email: 'wrong@test.com', password: 'password' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException on wrong password', async () => {
      dbMock.query.users.findFirst.mockResolvedValue({
        id: 1,
        email: 'test@test.com',
        password: 'hashed-password',
        roleId: 2,
      });
      vi.mocked(bcrypt.compare).mockImplementation(async () => false);

      await expect(service.login({ email: 'test@test.com', password: 'wrong' })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should login successfully with correct credentials', async () => {
      dbMock.query.users.findFirst.mockResolvedValue({
        id: 1,
        email: 'test@test.com',
        name: 'Test User',
        password: 'hashed-password',
        roleId: 2,
      });
      dbMock.query.roles.findFirst.mockResolvedValue({
        id: 2,
        name: 'PARTICIPANT',
      });
      vi.mocked(bcrypt.compare).mockImplementation(async () => true);

      const result = await service.login({
        email: 'test@test.com',
        password: 'password',
      });

      expect(bcrypt.compare).toHaveBeenCalledWith('password', 'hashed-password');
      expect(result.accessToken).toBe('mocked-token');
      expect(result.user.email).toBe('test@test.com');
      expect(jwtServiceMock.sign).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ tokenType: 'access' }),
        { expiresIn: '15m' },
      );
      expect(jwtServiceMock.sign).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ tokenType: 'refresh' }),
        { expiresIn: '30d' },
      );
    });
  });

  describe('refresh', () => {
    it('rejects an access token', async () => {
      jwtServiceMock.verify.mockReturnValue({ sub: 1, tokenType: 'access' });
      await expect(service.refresh('access-token')).rejects.toThrow(UnauthorizedException);
      expect(dbMock.query.users.findFirst).not.toHaveBeenCalled();
    });
  });
});
