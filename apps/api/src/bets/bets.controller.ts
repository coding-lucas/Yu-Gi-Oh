import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { toMinor } from '@athosbet/shared';
import { AuthUser, Client, ClientInfo, CurrentUser, Public } from '../common/auth';
import { ZodPipe } from '../common/zod';
import { BetsService } from './bets.service';

const PlaceSchema = z.object({
  legs: z.array(z.object({ oddsId: z.number().int().positive(), odds: z.number().min(1.001).max(10000) })).min(1).max(20),
  stake: z.union([z.string(), z.number()]),
  idempotencyKey: z.string().min(8).max(100),
  oddsPolicy: z.enum(['NONE', 'HIGHER', 'ANY']).default('NONE'),
});

@ApiTags('bets')
@Controller()
export class BetsController {
  constructor(private readonly bets: BetsService) {}

  @Post('bets')
  place(@CurrentUser() u: AuthUser, @Client() c: ClientInfo, @Body(new ZodPipe(PlaceSchema)) b: z.infer<typeof PlaceSchema>) {
    let stake: bigint;
    try {
      stake = toMinor(b.stake as any);
    } catch {
      stake = 0n;
    }
    return this.bets.place(u.id, c, {
      legs: b.legs.map((l) => ({ oddsId: l.oddsId, oddsK: Math.round(l.odds * 1000) })),
      stake, idempotencyKey: b.idempotencyKey, oddsPolicy: b.oddsPolicy,
    });
  }

  @Get('bets')
  list(@CurrentUser() u: AuthUser, @Query('status') status?: 'OPEN' | 'SETTLED') {
    return this.bets.list(u.id, status);
  }

  @Get('bets/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bets.get(u.id, id);
  }

  @Public()
  @Get('markets/:id/history')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.bets.oddsHistory(id);
  }
}
