import { Logger, OnModuleInit } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { ACCESS_COOKIE, verifyAccess } from '../common/auth';
import { config } from '../config';
import { EventBus } from './events';
import { PricingService } from '../odds/pricing.service';

function cookie(header: string | undefined, name: string) {
  return header?.split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
}

/**
 * Real-time channel: odds/match updates per match room and private wallet/bet notifications per user.
 */
@WebSocketGateway({ path: '/api/ws', cors: { origin: config().CORS_ORIGIN.split(','), credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit {
  private readonly log = new Logger(RealtimeGateway.name);
  @WebSocketServer() server: Server;

  constructor(private readonly bus: EventBus, private readonly pricing: PricingService) {}

  onModuleInit() {
    this.bus.on('odds.updated', async (e) => {
      if (!this.server) return;
      const room = `match:${e.matchId}`;
      if ((await this.server.in(room).fetchSockets()).length === 0) {
        this.server.emit('board', { matchId: e.matchId });
        return;
      }
      this.server.to(room).emit('odds', { matchId: e.matchId, markets: await this.pricing.marketsFor(e.matchId) });
      this.server.emit('board', { matchId: e.matchId });
    });
    this.bus.on('match.updated', (e) => this.server?.emit('match', e));
    this.bus.on('wallet.updated', (e) => this.server?.to(`user:${e.userId}`).emit('wallet', {}));
    this.bus.on('bet.settled', (e) => this.server?.to(`user:${e.userId}`).emit('bet', { betId: e.betId, status: e.status }));
  }

  handleConnection(client: Socket) {
    const token = cookie(client.handshake.headers.cookie, ACCESS_COOKIE) ?? (client.handshake.auth as any)?.token;
    const user = token ? verifyAccess(decodeURIComponent(token)) : null;
    if (user) client.join(`user:${user.id}`);
  }

  @SubscribeMessage('watch')
  watch(@ConnectedSocket() client: Socket, @MessageBody() matchId: string) {
    if (typeof matchId === 'string' && /^[0-9a-f-]{36}$/.test(matchId)) client.join(`match:${matchId}`);
  }

  @SubscribeMessage('unwatch')
  unwatch(@ConnectedSocket() client: Socket, @MessageBody() matchId: string) {
    client.leave(`match:${matchId}`);
  }
}
