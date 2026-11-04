import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { err } from '../common/errors';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { toMinor } from '@athosbet/shared';
import { AuthUser, Client, ClientInfo, CurrentUser, Public } from '../common/auth';
import { ZodPipe } from '../common/zod';
import { WalletService } from './wallet.service';
import { PaymentsService } from '../payments/payments.service';
import { PAYMENT_METHODS } from '../payments/provider';
import { config } from '../config';

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
const method = z.enum(PAYMENT_METHODS as [string, ...string[]]);
const returnUrl = z.string().url().max(500).refine((u) => u.startsWith(config().PUBLIC_APP_URL), 'returnUrl must be on the AthosBet origin').optional();
const DepositSchema = z.object({
  amount, method,
  idempotencyKey: z.string().min(8).max(100),
  /** Paysafe.js single-use payment handle token (cards) — raw card data is never accepted for real gateways */
  paymentToken: z.string().min(8).max(200).optional(),
  /** internal simulator only: test card number */
  card: z.object({ number: z.string().regex(/^[\d ]{12,23}$/) }).optional(),
  returnUrl,
});
const WithdrawSchema = z.object({
  amount, method, idempotencyKey: z.string().min(8).max(100),
  paymentToken: z.string().min(8).max(200).optional(),
  payoutDetails: z.record(z.string().max(120)).refine((o) => Object.keys(o).length <= 10).optional(),
});

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
  methods(@CurrentUser() u: AuthUser, @Client() c: ClientInfo) {
    return this.payments.methods(u.id, c);
  }

  @Get('payments')
  list(@CurrentUser() u: AuthUser) {
    return this.payments.list(u.id);
  }

  @Post('payments/deposits')
  deposit(@CurrentUser() u: AuthUser, @Client() c: ClientInfo, @Body(new ZodPipe(DepositSchema)) b: z.infer<typeof DepositSchema>) {
    return this.payments.deposit(u.id, c, b as any);
  }

  @HttpCode(200)
  @Post('payments/:id/confirm')
  confirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ paymentToken: z.string().min(8).max(200) }))) b: { paymentToken: string }) {
    return this.payments.confirm(u.id, id, b.paymentToken);
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

  /** Provider webhooks (e.g. /api/payments/webhooks/paysafe). Signature verified per provider; raw body required. */
  @Public()
  @HttpCode(200)
  @Post('payments/webhooks/:provider')
  webhook(@Param('provider') provider: string, @Req() req: Request & { rawBody?: Buffer }) {
    if (!/^[a-z]{2,20}$/.test(provider)) throw err.notFound();
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    return this.payments.handleWebhook(provider, req.rawBody?.toString('utf8') ?? JSON.stringify(req.body), headers);
  }
}
