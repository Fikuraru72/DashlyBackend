import { Emitter } from '@socket.io/redis-emitter';
import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { and, eq, isNull } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Redis from 'ioredis';

import { getRedisOptions } from '../redis/redis-options';
import { Server, Socket } from 'socket.io';

import { DB_CONNECTION } from '../../db/database.module';
import * as schema from '../../db/schema';
import { AuthenticatedUser, JwtPayload } from '../auth/strategies/jwt.strategy';

interface AuthenticatedSocket extends Socket {
  data: { user?: AuthenticatedUser };
}

@WebSocketGateway({
  cors: { origin: true, methods: ['GET', 'POST'], credentials: true },
  transports: ['websocket', 'polling'],
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server?: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private readonly redis: Redis;
  private readonly emitter: Emitter;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {
    this.redis = new Redis(getRedisOptions(configService));
    this.emitter = new Emitter(this.redis);
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  handleConnection(client: AuthenticatedSocket) {
    const token = client.handshake.auth?.token;
    if (token === undefined) {
      this.logger.log(`Public client connected: ${client.id}`);
      return;
    }

    try {
      if (typeof token !== 'string') throw new Error('Invalid token');
      const payload = this.jwtService.verify<JwtPayload>(token);
      if (payload.tokenType !== 'access' || !payload.email || !payload.role) {
        throw new Error('Wrong token type');
      }
      client.data.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };
      this.logger.log(`Authenticated client connected: ${client.id}`);
    } catch {
      client.emit('auth_error', { message: 'Invalid access token' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('joinEventRoom')
  async handleJoinRoom(
    @MessageBody() data: { eventId: number },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    const eventId = data?.eventId;
    const user = client.data.user;
    if (!user || !Number.isInteger(eventId) || eventId <= 0) {
      return { event: 'joinError', data: 'Invalid event room request' };
    }
    if (!(await this.canAccessEvent(user, eventId))) {
      return { event: 'joinError', data: 'Event access denied' };
    }

    const room = `event_${eventId}`;
    await client.join(room);
    this.logger.log(`Client ${client.id} joined room: ${room}`);
    return { event: 'joinedRoom', data: room };
  }

  @SubscribeMessage('joinPublicEventRoom')
  async handleJoinPublicRoom(
    @MessageBody() data: { eventId: number },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    const eventId = data?.eventId;
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return { event: 'joinError', data: 'Invalid public event room request' };
    }
    const event = await this.db.query.events.findFirst({
      where: and(eq(schema.events.id, eventId), isNull(schema.events.deletedAt)),
      columns: { id: true },
    });
    if (!event) return { event: 'joinError', data: 'Event not found' };

    const room = `public_event_${eventId}`;
    await client.join(room);
    return { event: 'joinedRoom', data: room };
  }

  @SubscribeMessage('leaveEventRoom')
  async handleLeaveRoom(
    @MessageBody() data: { eventId: number },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    const room = `event_${data.eventId}`;
    await client.leave(room);
    return { event: 'leftRoom', data: room };
  }

  @SubscribeMessage('leavePublicEventRoom')
  async handleLeavePublicRoom(
    @MessageBody() data: { eventId: number },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    const room = `public_event_${data.eventId}`;
    await client.leave(room);
    return { event: 'leftRoom', data: room };
  }

  private async canAccessEvent(user: AuthenticatedUser, eventId: number) {
    if (user.role === 'SUPER_ADMIN') return true;
    if (user.role === 'STAFF') {
      return Boolean(
        await this.db.query.eventStaff.findFirst({
          where: and(eq(schema.eventStaff.eventId, eventId), eq(schema.eventStaff.userId, user.id)),
        }),
      );
    }
    if (user.role === 'PARTICIPANT') {
      return Boolean(
        await this.db.query.eventParticipants.findFirst({
          where: and(
            eq(schema.eventParticipants.eventId, eventId),
            eq(schema.eventParticipants.userId, user.id),
          ),
        }),
      );
    }
    return false;
  }

  broadcastPositionUpdate(eventId: number, payload: any) {
    const update = {
      eventId,
      positions: [{ ...payload, lat: Number(payload.lat), lng: Number(payload.lng) }],
    };
    this.emit(eventId, 'position_batch', update);
    this.emitPublic(eventId, 'position_batch', update);
  }

  private emit(eventId: number, event: string, payload: unknown) {
    this.emitter.to(`event_${eventId}`).emit(event, payload);
  }

  private emitPublic(eventId: number, event: string, payload: unknown) {
    this.emitter.to(`public_event_${eventId}`).emit(event, payload);
  }

  broadcastAnomalyDetected(eventId: number, payload: any) {
    this.emit(eventId, 'anomaly_detected', payload);
  }
  broadcastSyncBatch(eventId: number, userId: number, payload: any[]) {
    this.emit(eventId, 'sync_batch', { userId, eventId, points: payload });
  }
  broadcastSosTriggered(eventId: number, payload: any) {
    this.emit(eventId, 'sos_triggered', payload);
  }
  broadcastSosRecovered(eventId: number, payload: any) {
    this.emit(eventId, 'sos_recovered', payload);
  }
  broadcastAnomaly(eventId: number, payload: any) {
    this.emit(eventId, 'anomaly_detected', payload);
  }
  broadcastEventStatus(eventId: number, status: string) {
    const payload = { status };
    this.emit(eventId, 'EVENT_STATUS_CHANGED', payload);
    this.emitPublic(eventId, 'EVENT_STATUS_CHANGED', payload);
  }
  broadcastRankingUpdate(eventId: number, payload: any) {
    this.emit(eventId, 'ranking_update', payload);
  }
  broadcastOffRouteAlert(eventId: number, payload: any) {
    this.emit(eventId, 'off_route_alert', payload);
  }
  broadcastUserStopped(eventId: number, payload: any) {
    this.emit(eventId, 'user_stopped', payload);
  }
  broadcastParticipantFinished(eventId: number, payload: any) {
    this.emit(eventId, 'participant_finished', payload);
  }
}
