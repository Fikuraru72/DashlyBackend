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
import { Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: true, // Allow any origin dynamically, supporting local IP accesses (192.168.x.x)
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'], // Explicitly allow protocol upgrades
})
export class EventsGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private logger: Logger = new Logger('EventsGateway');

  // Accumulator: keyed by eventId, holds latest position per participantId
  private positionBuffer: Map<number, Map<number, any>> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 2000; // Emit every 2 seconds

  onModuleInit() {
    this.flushInterval = setInterval(
      () => this.flushPositionBuffer(),
      this.FLUSH_INTERVAL_MS,
    );
  }

  onModuleDestroy() {
    if (this.flushInterval) clearInterval(this.flushInterval);
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('joinEventRoom')
  handleJoinRoom(
    @MessageBody() data: { eventId: number },
    @ConnectedSocket() client: Socket,
  ) {
    const room = `event_${data.eventId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} joined room: ${room}`);
    return { event: 'joinedRoom', data: room };
  }

  @SubscribeMessage('leaveEventRoom')
  handleLeaveRoom(
    @MessageBody() data: { eventId: number },
    @ConnectedSocket() client: Socket,
  ) {
    const room = `event_${data.eventId}`;
    client.leave(room);
    this.logger.log(`Client ${client.id} left room: ${room}`);
    return { event: 'leftRoom', data: room };
  }

  // Called by MqttService — buffers the update instead of emitting immediately
  broadcastPositionUpdate(eventId: number, payload: any) {
    const data = {
      ...payload,
      lat: parseFloat(payload.lat),
      lng: parseFloat(payload.lng),
    };

    if (!this.positionBuffer.has(eventId)) {
      this.positionBuffer.set(eventId, new Map());
    }
    // Always overwrite with the latest point per participant (deduplicates rapid updates)
    this.positionBuffer
      .get(eventId)!
      .set(data.participantId || data.userId, data);
  }

  // Flush accumulated updates to dashboards every 2 seconds
  private flushPositionBuffer() {
    for (const [eventId, userMap] of this.positionBuffer.entries()) {
      if (userMap.size === 0) continue;

      const room = `event_${eventId}`;
      const roomClients = this.server.sockets.adapter.rooms.get(room);
      if (!roomClients || roomClients.size === 0) {
        userMap.clear();
        continue;
      }

      // Send all participant positions as a single batch emission
      const positions = Array.from(userMap.values());
      this.server.to(room).emit('position_batch', { eventId, positions });
      this.logger.log(
        `[WS EMIT] 📡 position_batch → room: ${room} (${roomClients.size} clients, ${positions.length} positions)`,
      );

      userMap.clear();
    }
  }

  broadcastAnomalyDetected(eventId: number, payload: any) {
    const room = `event_${eventId}`;
    const roomClients = this.server.sockets.adapter.rooms.get(room);
    if (roomClients && roomClients.size > 0) {
      this.logger.warn(
        `[WS Out] -> ${room}: Broadcasting anomaly_detected: ${payload.type}`,
      );
      this.server.to(room).emit('anomaly_detected', payload);
    }
  }

  broadcastSyncBatch(eventId: number, userId: number, payload: any[]) {
    const room = `event_${eventId}`;
    const roomClients = this.server.sockets.adapter.rooms.get(room);
    if (roomClients && roomClients.size > 0) {
      this.server
        .to(room)
        .emit('sync_batch', { userId, eventId, points: payload });
    }
  }

  broadcastSosRecovered(eventId: number, payload: any) {
    const room = `event_${eventId}`;
    this.server.to(room).emit('sos_recovered', payload);
  }

  // Called to broadcast detected anomalies to the dashboard
  broadcastAnomaly(eventId: number, payload: any) {
    const room = `event_${eventId}`;
    this.server.to(room).emit('anomaly_detected', payload);
  }

  // Called to broadcast event status changes (Auto Start/End)
  broadcastEventStatus(eventId: number, status: string) {
    const room = `event_${eventId}`;
    this.server.to(room).emit('EVENT_STATUS_CHANGED', { status });
  }

  // ═══════════════════════════════════════════════════════════════
  //  PHASE 1: INTELLIGENCE LAYER BROADCASTS
  // ═══════════════════════════════════════════════════════════════

  broadcastRankingUpdate(eventId: number, payload: any) {
    const room = `event_${eventId}`;
    this.server.to(room).emit('ranking_update', payload);
  }

  broadcastOffRouteAlert(eventId: number, payload: any) {
    const room = `event_${eventId}`;
    this.server.to(room).emit('off_route_alert', payload);
  }

  broadcastUserStopped(eventId: number, payload: any) {
    const room = `event_${eventId}`;
    this.server.to(room).emit('user_stopped', payload);
  }

  broadcastParticipantFinished(eventId: number, payload: any) {
    const room = `event_${eventId}`;
    this.server.to(room).emit('participant_finished', payload);
  }
}
