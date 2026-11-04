import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DEMO_CURRENCY } from '@athosbet/shared';
import { Database, DbService } from '../db/db.service';
import { paymentEvents, payments } from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { ComplianceService } from '../compliance/compliance.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { err } from '../common/errors';
import { ClientInfo } from '../common/auth';
import { config } from '../config';
import { EventBus } from '../realtime/events';
import { DisabledRealGateway, METHOD_MARKETS, PAYMENT_METHODS, PaymentGateway, PaymentMethod, SandboxGateway } from './gateway';

type PaymentRow = typeof payments.$inferSelect;

export function serializePayment(p: PaymentRow) {
  return { ...p, amount: p.amount.toString() };
}

@Injectable()
export class PaymentsService {
  readonly sandbox: SandboxGateway;
  private readonly real: PaymentGateway[];

  constructor(
    private readonly dbs: DbService,
    private readonly ledger: LedgerService,
    private readonly compliance: ComplianceService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
  ) {
    this.sandbox = new SandboxGateway(config().SANDBOX_WEBHOOK_SECRET);
    this.real = [new DisabledRealGateway('nuvei'), new DisabledRealGateway('paysafe')];
  }

  /** Methods offered to this player. Real-money methods appear only when licensed and enabled. */
  async methods(country: string) {
    const jur = await this.compliance.jurisdictionStatus(country);
    return PAYMENT_METHODS.map((m) => {
      const markets = METHOD_MARKETS[m];
      const legalHere = markets === '*' || markets.includes(country);
      const realAvailable = config().REAL_MONEY_ENABLED && jur === 'LICENSED' && legalHere && this.real.some((g) => g.supports(m, country));
      return { method: m, sandbox: jur !== 'BLOCKED', real: realAvailable };
    });
  }

  async deposit(userId: string, client: ClientInfo, input: { amount: bigint; method: PaymentMethod; idempotencyKey: string; card?: { number: string } }) {
    const mode = 'SANDBOX' as const;
    const [dup] = await this.dbs.db.select().from(payments).where(and(eq(payments.userId, userId), eq(payments.idempotencyKey, input.idempotencyKey)));
    if (dup) {
      if (dup.amount !== input.amount || dup.direction !== 'DEPOSIT') throw err.conflict('IDEMPOTENCY_KEY_REUSED');
      return { payment: serializePayment(dup), idempotentReplay: true };
    }
    const payment = await this.dbs.tx(async (tx) => {
      await this.compliance.assertCanPlay(tx, userId, client.country, mode, 'DEPOSIT');
      await this.compliance.assertDepositWithinLimits(tx, userId, input.amount);
      const [p] = await tx.insert(payments).values({
        userId, provider: this.sandbox.name, method: input.method, direction: 'DEPOSIT', amount: input.amount, currency: DEMO_CURRENCY, mode,
        status: 'PENDING', idempotencyKey: input.idempotencyKey,
      }).onConflictDoNothing().returning();
      if (!p) throw err.conflict('DUPLICATE_REQUEST');
      return p;
    });
    const g = await this.sandbox.createDeposit({ paymentId: payment.id, amount: input.amount, currency: DEMO_CURRENCY, method: input.method, card: input.card });
    await this.dbs.db.update(payments).set({ providerRef: g.providerRef, metadata: { instructions: g.instructions ?? null }, updatedAt: new Date() }).where(eq(payments.id, payment.id));
    if (g.status === 'COMPLETED') await this.completeDeposit(payment.id, `sync:${payment.id}`);
    if (g.status === 'FAILED') await this.dbs.db.update(payments).set({ status: 'FAILED', failureReason: g.failureReason, updatedAt: new Date() }).where(eq(payments.id, payment.id));
    const [fresh] = await this.dbs.db.select().from(payments).where(eq(payments.id, payment.id));
    return { payment: serializePayment(fresh), instructions: g.instructions ?? null };
  }

  /** Credits a deposit exactly once, whatever the number of webhook deliveries. */
  async completeDeposit(paymentId: string, eventKey: string) {
    let userId = '';
    await this.dbs.tx(async (tx) => {
      const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
      if (!p) throw err.notFound('PAYMENT_NOT_FOUND');
      userId = p.userId;
      if (p.direction !== 'DEPOSIT') throw err.badRequest('NOT_A_DEPOSIT');
      if (p.status === 'COMPLETED') return;
      if (p.status !== 'PENDING') throw err.conflict('PAYMENT_NOT_PENDING');
      const wallet = await this.ledger.userAccount(tx, p.userId, p.currency, p.mode);
      const clearing = await this.ledger.houseAccount(tx, 'PAYMENT_CLEARING', p.currency, p.mode);
      const t = await this.ledger.post(tx, {
        type: 'DEPOSIT', idempotencyKey: `payment:${p.id}:complete`, referenceType: 'payment', referenceId: p.id, metadata: { method: p.method, eventKey },
        entries: [{ accountId: clearing.id, amount: -p.amount }, { accountId: wallet.id, amount: p.amount }],
      });
      await tx.update(payments).set({ status: 'COMPLETED', ledgerTxId: t.id, updatedAt: new Date() }).where(eq(payments.id, p.id));
      const risk = await this.settings.get('risk');
      await this.compliance.amlChecks(tx, p.userId, 'DEPOSIT', p.amount, risk.largeDepositFlag);
    });
    this.bus.emit({ type: 'wallet.updated', userId });
  }

  /**
   * Webhook entry point. Deduplicated by (provider, event id) and protected by an HMAC signature.
   */
  async handleSandboxWebhook(rawBody: string, signature: string | undefined) {
    if (!this.sandbox.verifyWebhook(rawBody, signature)) throw err.unauthorized('INVALID_SIGNATURE');
    const evt = JSON.parse(rawBody) as { id: string; type: 'payment.succeeded' | 'payment.failed'; providerRef: string };
    const inserted = await this.dbs.db.insert(paymentEvents).values({ provider: 'sandbox', eventId: evt.id, payload: evt as any }).onConflictDoNothing().returning();
    if (inserted.length === 0) return { duplicate: true };
    const [p] = await this.dbs.db.select().from(payments).where(and(eq(payments.provider, 'sandbox'), eq(payments.providerRef, evt.providerRef)));
    if (!p) throw err.notFound('PAYMENT_NOT_FOUND');
    if (evt.type === 'payment.succeeded') {
      if (p.direction === 'DEPOSIT') await this.completeDeposit(p.id, evt.id);
      else await this.completeWithdrawal(p.id);
    } else {
      if (p.direction === 'DEPOSIT') await this.dbs.db.update(payments).set({ status: 'FAILED', failureReason: 'PROVIDER_FAILED', updatedAt: new Date() }).where(and(eq(payments.id, p.id), eq(payments.status, 'PENDING')));
      else await this.rejectWithdrawal(p.id, 'PROVIDER_FAILED', null);
    }
    return { duplicate: false };
  }

  /** Test helper used by the sandbox UI: produces a correctly signed webhook for a pending payment. */
  async simulateConfirmation(userId: string, paymentId: string, outcome: 'payment.succeeded' | 'payment.failed') {
    const [p] = await this.dbs.db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.userId, userId)));
    if (!p || !p.providerRef) throw err.notFound('PAYMENT_NOT_FOUND');
    const body = JSON.stringify({ id: `evt_${paymentId}_${outcome}`, type: outcome, providerRef: p.providerRef });
    return this.handleSandboxWebhook(body, this.sandbox.sign(body));
  }

  /** Withdrawal: funds leave the wallet immediately into WITHDRAWALS_PENDING (no double spending). */
  async withdraw(userId: string, client: ClientInfo, input: { amount: bigint; method: PaymentMethod; idempotencyKey: string }) {
    const mode = 'SANDBOX' as const;
    const [dup] = await this.dbs.db.select().from(payments).where(and(eq(payments.userId, userId), eq(payments.idempotencyKey, input.idempotencyKey)));
    if (dup) {
      if (dup.amount !== input.amount || dup.direction !== 'WITHDRAWAL') throw err.conflict('IDEMPOTENCY_KEY_REUSED');
      return { payment: serializePayment(dup), idempotentReplay: true };
    }
    const risk = await this.settings.get('risk');
    const payment = await this.dbs.tx(async (tx) => {
      await this.compliance.assertCanPlay(tx, userId, client.country, mode, 'WITHDRAW');
      const review = input.amount >= BigInt(risk.largeWithdrawalReview);
      const [p] = await tx.insert(payments).values({
        userId, provider: this.sandbox.name, method: input.method, direction: 'WITHDRAWAL', amount: input.amount, currency: DEMO_CURRENCY, mode,
        status: review ? 'REQUIRES_REVIEW' : 'PENDING', idempotencyKey: input.idempotencyKey,
      }).onConflictDoNothing().returning();
      if (!p) throw err.conflict('DUPLICATE_REQUEST');
      const wallet = await this.ledger.userAccount(tx, userId, DEMO_CURRENCY, mode);
      const pending = await this.ledger.houseAccount(tx, 'WITHDRAWALS_PENDING', DEMO_CURRENCY, mode);
      const t = await this.ledger.post(tx, {
        type: 'WITHDRAWAL_REQUEST', idempotencyKey: `payment:${p.id}:request`, referenceType: 'payment', referenceId: p.id,
        entries: [{ accountId: wallet.id, amount: -input.amount, requireNonNegative: true }, { accountId: pending.id, amount: input.amount }],
      });
      await tx.update(payments).set({ ledgerTxId: t.id }).where(eq(payments.id, p.id));
      await this.compliance.amlChecks(tx, userId, 'WITHDRAWAL', input.amount, risk.largeDepositFlag);
      return { ...p, review };
    });
    this.bus.emit({ type: 'wallet.updated', userId });
    if (!payment.review) {
      const g = await this.sandbox.createPayout();
      await this.dbs.db.update(payments).set({ providerRef: g.providerRef }).where(eq(payments.id, payment.id));
      if (g.status === 'COMPLETED') await this.completeWithdrawal(payment.id);
    }
    const [fresh] = await this.dbs.db.select().from(payments).where(eq(payments.id, payment.id));
    return { payment: serializePayment(fresh) };
  }

  async completeWithdrawal(paymentId: string) {
    await this.dbs.tx(async (tx) => {
      const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
      if (!p || p.direction !== 'WITHDRAWAL') throw err.notFound('PAYMENT_NOT_FOUND');
      if (p.status === 'COMPLETED') return;
      if (!['PENDING', 'REQUIRES_REVIEW'].includes(p.status)) throw err.conflict('PAYMENT_NOT_PENDING');
      const pending = await this.ledger.houseAccount(tx, 'WITHDRAWALS_PENDING', p.currency, p.mode);
      const clearing = await this.ledger.houseAccount(tx, 'PAYMENT_CLEARING', p.currency, p.mode);
      await this.ledger.post(tx, {
        type: 'WITHDRAWAL_COMPLETE', idempotencyKey: `payment:${p.id}:complete`, referenceType: 'payment', referenceId: p.id,
        entries: [{ accountId: pending.id, amount: -p.amount }, { accountId: clearing.id, amount: p.amount }],
      });
      await tx.update(payments).set({ status: 'COMPLETED', updatedAt: new Date() }).where(eq(payments.id, p.id));
    });
  }

  async rejectWithdrawal(paymentId: string, reason: string, actor: { id: string; role: string } | null) {
    let userId = '';
    await this.dbs.tx(async (tx) => {
      const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
      if (!p || p.direction !== 'WITHDRAWAL') throw err.notFound('PAYMENT_NOT_FOUND');
      userId = p.userId;
      if (!['PENDING', 'REQUIRES_REVIEW'].includes(p.status)) throw err.conflict('PAYMENT_NOT_PENDING');
      await this.ledger.reverse(tx, p.ledgerTxId!, 'WITHDRAWAL_REVERSAL', `payment:${p.id}:reverse`, { reason });
      await tx.update(payments).set({ status: 'CANCELLED', failureReason: reason, updatedAt: new Date() }).where(eq(payments.id, p.id));
      if (actor) await this.audit.log({ actorId: actor.id, actorRole: actor.role, action: 'payment.withdrawal.reject', entityType: 'payment', entityId: p.id, after: { reason } }, tx);
    });
    this.bus.emit({ type: 'wallet.updated', userId });
  }

  async approveWithdrawal(paymentId: string, actor: { id: string; role: string }) {
    await this.completeWithdrawal(paymentId);
    await this.audit.log({ actorId: actor.id, actorRole: actor.role, action: 'payment.withdrawal.approve', entityType: 'payment', entityId: paymentId });
  }

  async list(userId: string) {
    const rows = await this.dbs.db.select().from(payments).where(eq(payments.userId, userId)).orderBy(desc(payments.createdAt)).limit(100);
    return rows.map(serializePayment);
  }

  async get(tx: Database, id: string) {
    const [p] = await tx.select().from(payments).where(eq(payments.id, id));
    return p;
  }
}
