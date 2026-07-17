import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Server, ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private pubClient: Redis | null;
  private subClient: Redis | null;

  constructor(app: INestApplicationContext) {
    super(app);
    const config = app.get(ConfigService);
    this.pubClient = new Redis({
      host: config.get<string>('REDIS_HOST') || 'localhost',
      port: config.get<number>('REDIS_PORT') || 6379,
    });
    this.subClient = this.pubClient.duplicate();
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    server.adapter(createAdapter(this.pubClient!, this.subClient!));
    return server;
  }

  async close(server: Server): Promise<void> {
    await super.close(server);
    const clients = [this.pubClient, this.subClient].filter((client): client is Redis =>
      Boolean(client),
    );
    this.pubClient = null;
    this.subClient = null;
    await Promise.all(clients.map((client) => client.quit()));
  }
}
