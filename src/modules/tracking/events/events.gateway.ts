import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'], // Explicitly allow protocol upgrades
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private logger: Logger = new Logger('EventsGateway');

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

  // Called internally by MqttService to push data visually
  broadcastPositionUpdate(eventId: number, payload: any) {
    const room = `event_${eventId}`;
    
    // Safety Casting: Ensure coords are numbers for the dashboard mapping
    const data = {
      ...payload,
      lat: parseFloat(payload.lat),
      lng: parseFloat(payload.lng),
    };

    this.server.to(room).emit('position_update', data);
  }

  // Called to broadcast detected anomalies to the dashboard
  broadcastAnomaly(eventId: number, payload: any) {
    const room = `event_${eventId}`;
    this.server.to(room).emit('anomaly_detected', payload);
  }
}
