import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';

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
export class EventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private readonly positionBuffer = new Map<number, Map<number, any>>();
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 2000;

  constructor(
    private readonly jwtService: JwtService,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  onModuleInit() {
    this.flushInterval = setInterval(() => this.flushPositionBuffer(), this.FLUSH_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.flushInterval) clearInterval(this.flushInterval);
  }

  handleConnection(client: AuthenticatedSocket) {
    try {
      const token = client.handshake.auth?.token;
      if (typeof token !== 'string') throw new Error('Missing token');
      const payload = this.jwtService.verify<JwtPayload>(token);
      if (payload.tokenType !== 'access' || !payload.email || !payload.role) {
        throw new Error('Wrong token type');
      }
      client.data.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };
      this.logger.log(`Client connected: ${client.id}`);
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

  @SubscribeMessage('leaveEventRoom')
  async handleLeaveRoom(
    @MessageBody() data: { eventId: number },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    const room = `event_${data.eventId}`;
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
    const data = { ...payload, lat: Number(payload.lat), lng: Number(payload.lng) };
    if (!this.positionBuffer.has(eventId)) {
      this.positionBuffer.set(eventId, new Map());
    }
    this.positionBuffer.get(eventId)!.set(data.participantId || data.userId, data);
  }

  private flushPositionBuffer() {
    for (const [eventId, userMap] of this.positionBuffer) {
      if (userMap.size === 0) continue;
      const room = `event_${eventId}`;
      const roomClients = this.server.sockets.adapter.rooms.get(room);
      if (!roomClients?.size) {
        userMap.clear();
        continue;
      }
      this.server.to(room).emit('position_batch', {
        eventId,
        positions: Array.from(userMap.values()),
      });
      userMap.clear();
    }
  }

  broadcastAnomalyDetected(eventId: number, payload: any) {
    this.server.to(`event_${eventId}`).emit('anomaly_detected', payload);
  }
  broadcastSyncBatch(eventId: number, userId: number, payload: any[]) {
    this.server.to(`event_${eventId}`).emit('sync_batch', { userId, eventId, points: payload });
  }
  broadcastSosRecovered(eventId: number, payload: any) {
    this.server.to(`event_${eventId}`).emit('sos_recovered', payload);
  }
  broadcastAnomaly(eventId: number, payload: any) {
    this.server.to(`event_${eventId}`).emit('anomaly_detected', payload);
  }
  broadcastEventStatus(eventId: number, status: string) {
    this.server.to(`event_${eventId}`).emit('EVENT_STATUS_CHANGED', { status });
  }
  broadcastRankingUpdate(eventId: number, payload: any) {
    this.server.to(`event_${eventId}`).emit('ranking_update', payload);
  }
  broadcastOffRouteAlert(eventId: number, payload: any) {
    this.server.to(`event_${eventId}`).emit('off_route_alert', payload);
  }
  broadcastUserStopped(eventId: number, payload: any) {
    this.server.to(`event_${eventId}`).emit('user_stopped', payload);
  }
  broadcastParticipantFinished(eventId: number, payload: any) {
    this.server.to(`event_${eventId}`).emit('participant_finished', payload);
  }
}
