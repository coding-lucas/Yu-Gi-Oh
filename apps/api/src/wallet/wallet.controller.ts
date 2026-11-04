import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { toMinor } from '@athosbet/shared';
import { AuthUser, Client, ClientInfo, CurrentUser, Public } from '../common/auth';
import { ZodPipe } from '../common/zod';
import { WalletService } from './wallet.service';
import { PaymentsService } from '../payments/payments.service';
import { PAYMENT_METHODS } from '../payments/gateway';

const amount = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    const m = toMinor(v as any);
    if (m <= 0n) throw new Error();
    return m;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid amount' });
    return z.NEVER;
  }
});
const DepositSchema = z.object({
  amount, method: z.enum(PAYMENT_METHODS as [string, ...string[]]),
  idempotencyKey: z.string().min(8).max(100),
  card: z.object({ number: z.string().regex(/^[\d ]{12,23}$/) }).optional(),
});
const WithdrawSchema = z.object({ amount, method: z.enum(PAYMENT_METHODS as [string, ...string[]]), idempotencyKey: z.string().min(8).max(100) });

@ApiTags('wallet')
@Controller()
export class WalletController {
  constructor(private readonly wallet: WalletService, private readonly payments: PaymentsService) {}

  @Get('wallet')
  summary(@CurrentUser() u: AuthUser) {
    return this.wallet.summary(u.id);
  }

  @Get('wallet/statement')
  statement(@CurrentUser() u: AuthUser) {
    return this.wallet.statement(u.id);
  }

  @Get('payments/methods')
  methods(@Client() c: ClientInfo) {
    return this.payments.methods(c.country);
  }

  @Get('payments')
  list(@CurrentUser() u: AuthUser) {
    return this.payments.list(u.id);
  }

  @Post('payments/deposits')
  deposit(@CurrentUser() u: AuthUser, @Client() c: ClientInfo, @Body(new ZodPipe(DepositSchema)) b: z.infer<typeof DepositSchema>) {
    return this.payments.deposit(u.id, c, b as any);
  }

  @Post('payments/withdrawals')
  withdraw(@CurrentUser() u: AuthUser, @Client() c: ClientInfo, @Body(new ZodPipe(WithdrawSchema)) b: z.infer<typeof WithdrawSchema>) {
    return this.payments.withdraw(u.id, c, b as any);
  }

  /** Sandbox only: simulates the PSP confirming (or failing) an asynchronous payment. */
  @HttpCode(200)
  @Post('payments/:id/simulate')
  simulate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ outcome: z.enum(['payment.succeeded', 'payment.failed']).default('payment.succeeded') }))) b: { outcome: 'payment.succeeded' | 'payment.failed' }) {
    return this.payments.simulateConfirmation(u.id, id, b.outcome);
  }

  @Public()
  @HttpCode(200)
  @Post('payments/webhooks/sandbox')
  webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-sandbox-signature') sig?: string) {
    return this.payments.handleSandboxWebhook(req.rawBody?.toString('utf8') ?? JSON.stringify(req.body), sig);
  }
}
