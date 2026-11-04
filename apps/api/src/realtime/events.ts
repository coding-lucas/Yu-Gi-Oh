import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export type DomainEvent =
  | { type: 'odds.updated'; matchId: string }
  | { type: 'match.updated'; matchId: string; status: string }
  | { type: 'match.result'; matchId: string; resultVersion: number }
  | { type: 'bet.settled'; betId: string; userId: string; status: string }
  | { type: 'wallet.updated'; userId: string };

/** In-process domain event bus; the WebSocket gateway and job scheduler subscribe to it. */
@Injectable()
export class EventBus {
  private readonly ee = new EventEmitter().setMaxListeners(100);
  emit(e: DomainEvent) {
    this.ee.emit(e.type, e);
    this.ee.emit('*', e);
  }
  on<T extends DomainEvent['type']>(type: T | '*', fn: (e: Extract<DomainEvent, { type: T }>) => void) {
    this.ee.on(type, fn as any);
    return () => this.ee.off(type, fn as any);
  }
}
