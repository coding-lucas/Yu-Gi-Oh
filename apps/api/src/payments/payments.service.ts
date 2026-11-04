import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { DEMO_CURRENCY } from '@athosbet/shared';
import { DbService } from '../db/db.service';
import { paymentEvents, paymentReconciliationRuns, payments, users, PaymentStatus } from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { ComplianceService } from '../compliance/compliance.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { err } from '../common/errors';
import { ClientInfo } from '../common/auth';
import { EventBus } from '../realtime/events';
import { OperationContext, PaymentDirection, PaymentMethod, ProviderResult } from './provider';
import { PaymentProviderRegistry } from './provider.registry';
import { EligibilityService } from './eligibility.service';
import { InternalSandboxProvider } from './providers/internal-sandbox.provider';
import { decrypt, encrypt } from '../common/crypto';
import { config } from '../config';

type PaymentRow = typeof payments.$inferSelect;
const TERMINAL: PaymentStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
const MODE = 'SANDBOX' as const; // real-money mode stays unavailable until legal authorisation

export function serializePayment(p: PaymentRow) {
  return { ...p, amount: p.amount.toString(), providerAmount: p.providerAmount?.toString() ?? null };
}

/**
 * Orchestrates payments over any PaymentProvider. Money only moves in the double-entry ledger, and
 * only on an AUTHORITATIVE provider status (synchronous API response or a re-read after webhook /
 * reconciliation) — never on webhook payload content alone.
 */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);
  constructor(
    private readonly dbs: DbService,
    private readonly ledger: LedgerService,
    private readonly compliance: ComplianceService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
    readonly registry: PaymentProviderRegistry,
    readonly eligibility: EligibilityService,
  ) {}

  get sandbox(): InternalSandboxProvider {
    return this.registry.get('sandbox') as InternalSandboxProvider;
  }

  private async userCountry(userId: string, client: ClientInfo) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw err.unauthorized();
    return { user: u, country: client.country !== 'XX' ? client.country : u.country };
  }

  async methods(userId: string | null, client: ClientInfo) {
    let country = client.country;
    if (userId && country === 'XX') country = (await this.userCountry(userId, client)).country;
    if ((await this.compliance.jurisdictionStatus(country)) === 'BLOCKED') return [];
    return this.eligibility.offered(country, MODE);
  }

  private ctx(p: PaymentRow, u: typeof users.$inferSelect, extra: Partial<OperationContext> = {}): OperationContext {
    return {
      paymentId: p.id, method: p.method as PaymentMethod, amount: p.providerAmount ?? p.amount, currency: p.providerCurrency ?? p.currency, country: p.country ?? u.country,
      customer: { id: u.id, email: u.email, ip: (p.metadata as any)?.ip ?? null, displayName: u.displayName },
      providerRef: p.providerRef, handleId: p.providerHandleId, ...extra,
    };
  }

  // ───────────────────────────── deposits ─────────────────────────────
  async deposit(userId: string, client: ClientInfo, input: { amount: bigint; method: PaymentMethod; idempotencyKey: string; paymentToken?: string; returnUrl?: string; card?: { number: string } }) {
    const [dup] = await this.dbs.db.select().from(payments).where(and(eq(payments.userId, userId), eq(payments.idempotencyKey, input.idempotencyKey)));
    if (dup) {
      if (dup.amount !== input.amount || dup.direction !== 'DEPOSIT') throw err.conflict('IDEMPOTENCY_KEY_REUSED');
      return { payment: serializePayment(dup), nextAction: dup.nextAction, idempotentReplay: true };
    }
    const { user, country } = await this.userCountry(userId, client);
    const payment = await this.dbs.tx(async (tx) => {
      await this.compliance.assertCanPlay(tx, userId, client.country, MODE, 'DEPOSIT');
      await this.compliance.assertDepositWithinLimits(tx, userId, input.amount);
      const route = await this.eligibility.resolve(input.method, 'DEPOSIT', country, MODE, tx);
      if (!route) throw err.unprocessable('PAYMENT_METHOD_NOT_AVAILABLE', { method: input.method, country });
      if (input.amount < route.row.minAmount || input.amount > route.row.maxAmount) throw err.unprocessable('AMOUNT_OUT_OF_RANGE', { min: route.row.minAmount.toString(), max: route.row.maxAmount.toString() });
      const [p] = await tx.insert(payments).values({
        userId, provider: route.provider.name, method: input.method, direction: 'DEPOSIT', amount: input.amount, currency: DEMO_CURRENCY, mode: MODE,
        status: 'PENDING', idempotencyKey: input.idempotencyKey, country, providerCurrency: route.row.currency,
        // sandbox: provider test amounts map 1:1 to fictitious ATH; real mode requires identical currencies
        providerAmount: input.amount, metadata: { ip: client.ip },
      }).onConflictDoNothing().returning();
      if (!p) throw err.conflict('DUPLICATE_REQUEST');
      await this.audit.log({ actorId: userId, actorRole: 'USER', action: 'payment.deposit.create', entityType: 'payment', entityId: p.id, after: { provider: p.provider, method: p.method, amount: p.amount, country }, ip: client.ip }, tx);
      return p;
    });
    const provider = this.registry.get(payment.provider)!;
    const token = input.paymentToken ?? input.card?.number;
    const result = await this.callProvider(payment, () => provider.createDeposit(this.ctx(payment, user, { paymentToken: token, returnUrl: input.returnUrl })));
    const fresh = await this.apply(payment.id, result, 'create');
    return { payment: serializePayment(fresh), nextAction: fresh.nextAction, instructions: (fresh.nextAction as any)?.instructions ?? null };
  }

  /** Card flow: the client returns the Paysafe.js payment-handle token for a REQUIRES_ACTION deposit. */
  async confirm(userId: string, paymentId: string, paymentToken: string) {
    const [p] = await this.dbs.db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.userId, userId)));
    if (!p) throw err.notFound('PAYMENT_NOT_FOUND');
    if (p.status !== 'REQUIRES_ACTION' || p.direction !== 'DEPOSIT') throw err.conflict('PAYMENT_NOT_AWAITING_ACTION');
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, userId));
    const provider = this.registry.get(p.provider)!;
    const result = await this.callProvider(p, () => provider.sync({ ...this.ctx(p, u, { paymentToken }), direction: 'DEPOSIT' }));
    return serializePayment(await this.apply(p.id, result, 'confirm'));
  }

  /** Provider errors: definitive rejections fail the operation; transient ones stay PENDING for the sync job. */
  private async callProvider(p: PaymentRow, fn: () => Promise<ProviderResult>): Promise<ProviderResult> {
    try {
      return await fn();
    } catch (e: any) {
      this.log.warn(`${p.provider} ${p.direction} ${p.id}: ${e?.message}`);
      const retryable = e?.retryable !== false;
      await this.audit.log({ actorRole: 'SYSTEM', action: 'payment.provider.error', entityType: 'payment', entityId: p.id, after: { provider: p.provider, code: e?.code, httpStatus: e?.httpStatus, retryable } });
      return retryable ? { status: 'PENDING', providerStatus: 'UNKNOWN_RETRYING' } : { status: 'FAILED', failureReason: e?.code ?? 'PROVIDER_REJECTED', providerStatus: 'REJECTED' };
    }
  }

  /**
   * Applies a provider status to a payment under row lock. Ledger effects are idempotent (keyed by
   * payment id) and happen exactly once per terminal transition. A provider reporting a different
   * terminal state for an already-final payment is flagged for manual review, never auto-reversed.
   */
  async apply(paymentId: string, r: ProviderResult, source: string): Promise<PaymentRow> {
    let userId = '';
    const out = await this.dbs.tx(async (tx) => {
      const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
      if (!p) throw err.notFound('PAYMENT_NOT_FOUND');
      userId = p.userId;
      const base = {
        providerRef: r.providerRef ?? p.providerRef, providerHandleId: r.handleId ?? p.providerHandleId, providerStatus: r.providerStatus ?? p.providerStatus,
        lastSyncedAt: new Date(), updatedAt: new Date(),
      };
      if (TERMINAL.includes(p.status)) {
        const terminalNow = TERMINAL.includes(r.status as PaymentStatus);
        if (terminalNow && r.status !== p.status) {
          await this.compliance.flag(p.userId, 'PAYMENT_STATUS_MISMATCH', 'HIGH', { paymentId: p.id, ours: p.status, provider: r.status, source }, tx);
          await this.audit.log({ actorRole: 'SYSTEM', action: 'payment.status.mismatch', entityType: 'payment', entityId: p.id, before: { status: p.status }, after: { provider: r.status, source } }, tx);
        }
        await tx.update(payments).set({ providerStatus: base.providerStatus, lastSyncedAt: base.lastSyncedAt }).where(eq(payments.id, p.id));
        return p;
      }
      if (p.status === 'REQUIRES_REVIEW') return p; // payout not sent yet — waits for an operator
      if (r.status === 'PENDING' || r.status === 'REQUIRES_ACTION') {
        const [u] = await tx.update(payments).set({ ...base, status: r.status, nextAction: (r.nextAction ?? p.nextAction ?? null) as any, syncAttempts: sql`${payments.syncAttempts} + 1` as any }).where(eq(payments.id, p.id)).returning();
        return u;
      }
      if (r.status === 'COMPLETED') await this.postCompletion(tx, p);
      else await this.postFailure(tx, p, r.failureReason ?? r.status);
      const [u] = await tx.update(payments).set({ ...base, status: r.status, nextAction: null, failureReason: r.status === 'COMPLETED' ? null : r.failureReason ?? r.status }).where(eq(payments.id, p.id)).returning();
      await this.audit.log({ actorRole: 'SYSTEM', action: `payment.${p.direction.toLowerCase()}.${r.status.toLowerCase()}`, entityType: 'payment', entityId: p.id, before: { status: p.status }, after: { status: r.status, providerRef: base.providerRef, source } }, tx);
      return u;
    });
    if (TERMINAL.includes(out.status)) this.bus.emit({ type: 'wallet.updated', userId });
    return out;
  }

  private async postCompletion(tx: Parameters<Parameters<DbService['tx']>[0]>[0], p: PaymentRow) {
    const clearing = await this.ledger.houseAccount(tx, 'PAYMENT_CLEARING', p.currency, p.mode);
    if (p.direction === 'DEPOSIT') {
      const wallet = await this.ledger.userAccount(tx, p.userId, p.currency, p.mode);
      const t = await this.ledger.post(tx, {
        type: 'DEPOSIT', idempotencyKey: `payment:${p.id}:complete`, referenceType: 'payment', referenceId: p.id, metadata: { provider: p.provider, method: p.method },
        entries: [{ accountId: clearing.id, amount: -p.amount }, { accountId: wallet.id, amount: p.amount }],
      });
      await tx.update(payments).set({ ledgerTxId: t.id }).where(eq(payments.id, p.id));
      const risk = await this.settings.get('risk');
      await this.compliance.amlChecks(tx, p.userId, 'DEPOSIT', p.amount, risk.largeDepositFlag);
    } else {
      const pending = await this.ledger.houseAccount(tx, 'WITHDRAWALS_PENDING', p.currency, p.mode);
      await this.ledger.post(tx, {
        type: p.direction === 'REFUND' ? 'REFUND_COMPLETE' : 'WITHDRAWAL_COMPLETE', idempotencyKey: `payment:${p.id}:complete`, referenceType: 'payment', referenceId: p.id,
        entries: [{ accountId: pending.id, amount: -p.amount }, { accountId: clearing.id, amount: p.amount }],
      });
    }
  }

  private async postFailure(tx: Parameters<Parameters<DbService['tx']>[0]>[0], p: PaymentRow, reason: string) {
    if (p.direction === 'DEPOSIT') return; // nothing was credited
    if (!p.ledgerTxId) return;
    await this.ledger.reverse(tx, p.ledgerTxId, p.direction === 'REFUND' ? 'REFUND_REVERSAL' : 'WITHDRAWAL_REVERSAL', `payment:${p.id}:reverse`, { reason });
  }

  // ───────────────────────────── webhooks ─────────────────────────────
  /**
   * Webhook pipeline: signature check → de-duplication by (provider, event id) → locate payment →
   * re-read authoritative status from the provider → apply. Invalid signatures are recorded and rejected.
   */
  async handleWebhook(providerName: string, rawBody: string, headers: Record<string, string | undefined>) {
    const provider = this.registry.get(providerName);
    if (!provider) throw err.notFound('UNKNOWN_PROVIDER');
    const evt = provider.parseWebhook(rawBody, headers);
    if (!evt) {
      await this.audit.log({ actorRole: 'SYSTEM', action: 'payment.webhook.invalid_signature', entityType: 'provider', entityId: providerName, after: { bytes: rawBody.length } });
      throw err.unauthorized('INVALID_SIGNATURE');
    }
    let p: PaymentRow | undefined;
    if (evt.merchantRef && /^[0-9a-f-]{36}$/.test(evt.merchantRef)) [p] = await this.dbs.db.select().from(payments).where(and(eq(payments.id, evt.merchantRef), eq(payments.provider, providerName)));
    if (!p && evt.providerRef) [p] = await this.dbs.db.select().from(payments).where(and(eq(payments.provider, providerName), or(eq(payments.providerRef, evt.providerRef), eq(payments.providerHandleId, evt.providerRef))));
    const inserted = await this.dbs.db.insert(paymentEvents).values({ provider: providerName, eventId: evt.eventId, payload: safeJson(rawBody), paymentId: p?.id ?? null }).onConflictDoNothing().returning();
    if (inserted.length === 0) return { duplicate: true };
    if (!p) {
      await this.audit.log({ actorRole: 'SYSTEM', action: 'payment.webhook.unmatched', entityType: 'provider', entityId: providerName, after: evt });
      return { duplicate: false, matched: false };
    }
    await this.syncOne(p);
    return { duplicate: false, matched: true };
  }

  private async syncOne(p: PaymentRow) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, p.userId));
    const provider = this.registry.get(p.provider);
    if (!provider) return p;
    const originalRef = p.parentPaymentId ? (await this.dbs.db.select({ r: payments.providerRef }).from(payments).where(eq(payments.id, p.parentPaymentId)))[0]?.r ?? undefined : undefined;
    const r = await this.callProvider(p, () => provider.sync({ ...this.ctx(p, u, { originalProviderRef: originalRef }), direction: p.direction }));
    return this.apply(p.id, r, 'sync');
  }

  /** Asynchronous confirmation safety net: polls non-final payments (covers lost webhooks). */
  async syncPending(olderThanMs = 60_000, limit = 100) {
    const rows = await this.dbs.db.select().from(payments).where(and(
      inArray(payments.status, ['PENDING', 'REQUIRES_ACTION']),
      lt(payments.createdAt, new Date(Date.now() - 5_000)),
      or(sql`${payments.lastSyncedAt} IS NULL`, lt(payments.lastSyncedAt, new Date(Date.now() - olderThanMs))),
    )).orderBy(payments.createdAt).limit(limit);
    let completed = 0;
    for (const p of rows) {
      const fresh = await this.syncOne(p).catch(() => p);
      if (fresh.status === 'COMPLETED') completed++;
      // abandoned deposits expire after 48h (no money was credited)
      if (!TERMINAL.includes(fresh.status) && fresh.direction === 'DEPOSIT' && p.createdAt < new Date(Date.now() - 48 * 3600_000)) {
        await this.apply(p.id, { status: 'CANCELLED', failureReason: 'EXPIRED' }, 'expiry');
      }
    }
    return { checked: rows.length, completed };
  }

  /** Sandbox helper: produces a correctly signed simulator webhook for a pending internal payment. */
  async simulateConfirmation(userId: string, paymentId: string, outcome: 'payment.succeeded' | 'payment.failed') {
    const [p] = await this.dbs.db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.userId, userId)));
    if (!p) throw err.notFound('PAYMENT_NOT_FOUND');
    if (p.provider !== 'sandbox') throw err.forbidden('ONLY_INTERNAL_SANDBOX');
    const body = JSON.stringify({ id: `evt_${paymentId}_${outcome}`, type: outcome, merchantRef: p.id, providerRef: p.providerRef });
    return this.handleWebhook('sandbox', body, { 'x-sandbox-signature': this.sandbox.sign(body) });
  }

  // ───────────────────────────── withdrawals ─────────────────────────────
  async withdraw(userId: string, client: ClientInfo, input: { amount: bigint; method: PaymentMethod; idempotencyKey: string; payoutDetails?: Record<string, string>; paymentToken?: string }) {
    const [dup] = await this.dbs.db.select().from(payments).where(and(eq(payments.userId, userId), eq(payments.idempotencyKey, input.idempotencyKey)));
    if (dup) {
      if (dup.amount !== input.amount || dup.direction !== 'WITHDRAWAL') throw err.conflict('IDEMPOTENCY_KEY_REUSED');
      return { payment: serializePayment(dup), idempotentReplay: true };
    }
    const { user, country } = await this.userCountry(userId, client);
    const risk = await this.settings.get('risk');
    const payment = await this.dbs.tx(async (tx) => {
      await this.compliance.assertCanPlay(tx, userId, client.country, MODE, 'WITHDRAW');
      const route = await this.eligibility.resolve(input.method, 'WITHDRAWAL', country, MODE, tx);
      if (!route) throw err.unprocessable('PAYMENT_METHOD_NOT_AVAILABLE', { method: input.method, country });
      const review = input.amount >= BigInt(risk.largeWithdrawalReview);
      const [p] = await tx.insert(payments).values({
        userId, provider: route.provider.name, method: input.method, direction: 'WITHDRAWAL', amount: input.amount, currency: DEMO_CURRENCY, mode: MODE,
        status: review ? 'REQUIRES_REVIEW' : 'PENDING', idempotencyKey: input.idempotencyKey, country, providerCurrency: route.row.currency, providerAmount: input.amount,
        metadata: {
          ip: client.ip, payoutDetails: maskDetails(input.payoutDetails), payoutToken: input.paymentToken ?? null,
          // full instrument kept only encrypted (AES-256-GCM) for payouts approved after manual review
          payoutEnc: input.payoutDetails ? encrypt(JSON.stringify(input.payoutDetails), config().DATA_ENCRYPTION_KEY) : null,
        },
      }).onConflictDoNothing().returning();
      if (!p) throw err.conflict('DUPLICATE_REQUEST');
      const wallet = await this.ledger.userAccount(tx, userId, DEMO_CURRENCY, MODE);
      const pending = await this.ledger.houseAccount(tx, 'WITHDRAWALS_PENDING', DEMO_CURRENCY, MODE);
      const t = await this.ledger.post(tx, {
        type: 'WITHDRAWAL_REQUEST', idempotencyKey: `payment:${p.id}:request`, referenceType: 'payment', referenceId: p.id,
        entries: [{ accountId: wallet.id, amount: -input.amount, requireNonNegative: true }, { accountId: pending.id, amount: input.amount }],
      });
      await tx.update(payments).set({ ledgerTxId: t.id }).where(eq(payments.id, p.id));
      await this.compliance.amlChecks(tx, userId, 'WITHDRAWAL', input.amount, risk.largeDepositFlag);
      await this.audit.log({ actorId: userId, actorRole: 'USER', action: 'payment.withdrawal.create', entityType: 'payment', entityId: p.id, after: { provider: p.provider, method: p.method, amount: p.amount, review }, ip: client.ip }, tx);
      return { ...p, ledgerTxId: t.id, review };
    });
    this.bus.emit({ type: 'wallet.updated', userId });
    if (!payment.review) await this.sendPayout(payment, user, input.payoutDetails, input.paymentToken);
    const [fresh] = await this.dbs.db.select().from(payments).where(eq(payments.id, payment.id));
    return { payment: serializePayment(fresh) };
  }

  private async sendPayout(p: PaymentRow, u: typeof users.$inferSelect, payoutDetails?: Record<string, string>, token?: string) {
    const provider = this.registry.get(p.provider)!;
    const enc = (p.metadata as any)?.payoutEnc as string | null | undefined;
    payoutDetails ??= enc ? JSON.parse(decrypt(enc, config().DATA_ENCRYPTION_KEY)) : undefined;
    const r = await this.callProvider(p, () => provider.createPayout(this.ctx(p, u, { payoutDetails, paymentToken: token ?? (p.metadata as any)?.payoutToken ?? undefined })));
    return this.apply(p.id, r, 'payout');
  }

  async approveWithdrawal(paymentId: string, actor: { id: string; role: string }) {
    const [p] = await this.dbs.db.update(payments).set({ status: 'PENDING', updatedAt: new Date() }).where(and(eq(payments.id, paymentId), eq(payments.status, 'REQUIRES_REVIEW'), eq(payments.direction, 'WITHDRAWAL'))).returning();
    if (!p) throw err.conflict('PAYMENT_NOT_IN_REVIEW');
    await this.audit.log({ actorId: actor.id, actorRole: actor.role, action: 'payment.withdrawal.approve', entityType: 'payment', entityId: paymentId });
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, p.userId));
    return serializePayment(await this.sendPayout(p, u));
  }

  async rejectWithdrawal(paymentId: string, reason: string, actor: { id: string; role: string } | null) {
    let userId = '';
    await this.dbs.tx(async (tx) => {
      const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
      if (!p || p.direction !== 'WITHDRAWAL') throw err.notFound('PAYMENT_NOT_FOUND');
      userId = p.userId;
      if (p.status !== 'REQUIRES_REVIEW') throw err.conflict('PAYMENT_NOT_IN_REVIEW');
      await this.ledger.reverse(tx, p.ledgerTxId!, 'WITHDRAWAL_REVERSAL', `payment:${p.id}:reverse`, { reason });
      await tx.update(payments).set({ status: 'CANCELLED', failureReason: reason, updatedAt: new Date() }).where(eq(payments.id, p.id));
      await this.audit.log({ actorId: actor?.id, actorRole: actor?.role ?? 'SYSTEM', action: 'payment.withdrawal.reject', entityType: 'payment', entityId: p.id, after: { reason } }, tx);
    });
    this.bus.emit({ type: 'wallet.updated', userId });
  }

  // ───────────────────────────── refunds ─────────────────────────────
  /**
   * Refund of a completed deposit back to the original instrument (operator action). The amount is
   * first held from the player's wallet (cannot refund money already gambled away), and the sum of
   * refunds can never exceed the original deposit.
   */
  async refund(depositId: string, amount: bigint | null, reason: string, actor: { id: string; role: string }, idempotencyKey: string) {
    const created = await this.dbs.tx(async (tx) => {
      const [d] = await tx.select().from(payments).where(eq(payments.id, depositId)).for('update');
      if (!d || d.direction !== 'DEPOSIT') throw err.notFound('PAYMENT_NOT_FOUND');
      if (d.status !== 'COMPLETED') throw err.conflict('DEPOSIT_NOT_COMPLETED');
      const [dup] = await tx.select().from(payments).where(and(eq(payments.userId, d.userId), eq(payments.idempotencyKey, idempotencyKey)));
      if (dup) return { p: dup, replay: true };
      const provider = this.registry.get(d.provider);
      if (!provider?.supports(d.method as PaymentMethod, 'REFUND')) throw err.unprocessable('REFUND_NOT_SUPPORTED');
      const r = await tx.execute(sql`SELECT COALESCE(SUM(amount),0)::bigint s FROM payments WHERE parent_payment_id = ${d.id} AND direction='REFUND' AND status NOT IN ('FAILED','CANCELLED')`);
      const already = BigInt((r.rows[0] as any).s);
      const amt = amount ?? d.amount - already;
      if (amt <= 0n || already + amt > d.amount) throw err.unprocessable('REFUND_EXCEEDS_DEPOSIT', { refunded: already.toString(), original: d.amount.toString() });
      const [p] = await tx.insert(payments).values({
        userId: d.userId, provider: d.provider, method: d.method, direction: 'REFUND', amount: amt, currency: d.currency, mode: d.mode, status: 'PENDING',
        idempotencyKey, country: d.country, providerCurrency: d.providerCurrency, providerAmount: amt, parentPaymentId: d.id, metadata: { reason },
      }).returning();
      const wallet = await this.ledger.userAccount(tx, d.userId, d.currency, d.mode);
      const pending = await this.ledger.houseAccount(tx, 'WITHDRAWALS_PENDING', d.currency, d.mode);
      const t = await this.ledger.post(tx, {
        type: 'REFUND_REQUEST', idempotencyKey: `payment:${p.id}:request`, referenceType: 'payment', referenceId: p.id, metadata: { deposit: d.id, reason },
        entries: [{ accountId: wallet.id, amount: -amt, requireNonNegative: true }, { accountId: pending.id, amount: amt }],
      });
      await tx.update(payments).set({ ledgerTxId: t.id }).where(eq(payments.id, p.id));
      await this.audit.log({ actorId: actor.id, actorRole: actor.role, action: 'payment.refund.create', entityType: 'payment', entityId: p.id, after: { deposit: d.id, amount: amt, reason } }, tx);
      return { p: { ...p, ledgerTxId: t.id }, replay: false, originalRef: d.providerRef };
    });
    if (created.replay) return serializePayment(created.p);
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, created.p.userId));
    const provider = this.registry.get(created.p.provider)!;
    const res = await this.callProvider(created.p, () => provider.refund(this.ctx(created.p, u, { originalProviderRef: (created as any).originalRef ?? undefined })));
    this.bus.emit({ type: 'wallet.updated', userId: created.p.userId });
    return serializePayment(await this.apply(created.p.id, res, 'refund'));
  }

  // ───────────────────────────── reconciliation ─────────────────────────────
  /**
   * Payment reconciliation per provider over a window:
   *   (a) provider status vs. our status for every payment with a provider reference;
   *   (b) ledger: each COMPLETED deposit has exactly one DEPOSIT posting of the same amount; each
   *       COMPLETED withdrawal/refund has a request and a completion posting; failed ones are reversed.
   */
  async reconcile(providerName: string, sinceDays = 7) {
    const [run] = await this.dbs.db.insert(paymentReconciliationRuns).values({ provider: providerName, status: 'OK' }).returning();
    const mismatches: Record<string, unknown>[] = [];
    let checked = 0;
    try {
      const provider = this.registry.get(providerName);
      if (!provider) throw new Error('unknown provider');
      const rows = await this.dbs.db.select().from(payments).where(and(eq(payments.provider, providerName), gte(payments.createdAt, new Date(Date.now() - sinceDays * 86_400_000)), isNotNull(payments.providerRef), ne(payments.status, 'REQUIRES_REVIEW')));
      for (const p of rows) {
        checked++;
        if (provider.isConfigured() && providerName !== 'sandbox') {
          const [u] = await this.dbs.db.select().from(users).where(eq(users.id, p.userId));
          try {
            const r = await provider.sync({ ...this.ctx(p, u), direction: p.direction });
            const ours = p.status;
            if (TERMINAL.includes(r.status as PaymentStatus) && r.status !== ours) mismatches.push({ paymentId: p.id, kind: 'STATUS', ours, provider: r.status });
            if (!TERMINAL.includes(ours) && r.status === 'COMPLETED') await this.apply(p.id, r, 'reconciliation');
          } catch (e: any) {
            mismatches.push({ paymentId: p.id, kind: 'LOOKUP_FAILED', error: e?.message });
          }
        }
      }
      const ledgerIssues = await this.dbs.db.execute(sql`
        SELECT p.id, p.direction, p.status, p.amount::text,
          (SELECT COUNT(*) FROM ledger_transactions t WHERE t.reference_type='payment' AND t.reference_id=p.id AND t.type IN ('DEPOSIT','WITHDRAWAL_COMPLETE','REFUND_COMPLETE'))::int completions,
          (SELECT COUNT(*) FROM ledger_transactions t WHERE t.reverses_id = p.ledger_tx_id)::int reversals,
          (SELECT COALESCE(SUM(e.amount),0) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id JOIN ledger_accounts a ON a.id=e.account_id
             WHERE t.reference_type='payment' AND t.reference_id=p.id AND t.type IN ('DEPOSIT') AND a.kind='USER_WALLET')::text credited
        FROM payments p WHERE p.provider = ${providerName} AND p.created_at > now() - (${sinceDays} || ' days')::interval`);
      for (const x of ledgerIssues.rows as any[]) {
        if (x.status === 'COMPLETED' && x.completions !== 1) mismatches.push({ paymentId: x.id, kind: 'LEDGER_COMPLETION_COUNT', count: x.completions });
        if (x.status === 'COMPLETED' && x.direction === 'DEPOSIT' && x.credited !== x.amount) mismatches.push({ paymentId: x.id, kind: 'LEDGER_AMOUNT', amount: x.amount, credited: x.credited });
        if (x.status !== 'COMPLETED' && x.completions > 0) mismatches.push({ paymentId: x.id, kind: 'LEDGER_UNEXPECTED_COMPLETION', status: x.status });
        if (['FAILED', 'CANCELLED'].includes(x.status) && x.direction !== 'DEPOSIT' && x.reversals !== 1) mismatches.push({ paymentId: x.id, kind: 'LEDGER_MISSING_REVERSAL' });
      }
      const status = mismatches.length ? 'MISMATCH' : 'OK';
      await this.dbs.db.update(paymentReconciliationRuns).set({ status, checked, mismatches: mismatches as any, finishedAt: new Date() }).where(eq(paymentReconciliationRuns.id, run.id));
      if (mismatches.length) await this.compliance.flag(null, 'PAYMENT_RECONCILIATION_MISMATCH', 'HIGH', { provider: providerName, mismatches: mismatches.slice(0, 20) });
      return { id: run.id, provider: providerName, status, checked, mismatches };
    } catch (e: any) {
      await this.dbs.db.update(paymentReconciliationRuns).set({ status: 'ERROR', checked, mismatches: [{ error: e?.message }] as any, finishedAt: new Date() }).where(eq(paymentReconciliationRuns.id, run.id));
      return { id: run.id, provider: providerName, status: 'ERROR', checked, mismatches: [{ error: e?.message }] };
    }
  }

  reconciliationRuns() {
    return this.dbs.db.select().from(paymentReconciliationRuns).orderBy(desc(paymentReconciliationRuns.id)).limit(50);
  }

  async list(userId: string) {
    const rows = await this.dbs.db.select().from(payments).where(eq(payments.userId, userId)).orderBy(desc(payments.createdAt)).limit(100);
    return rows.map((p) => ({ ...serializePayment(p), metadata: { instructions: (p.nextAction as any)?.instructions ?? null } }));
  }
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s.slice(0, 2000) };
  }
}

/** Never persist full payout instrument data; keep the last 4 characters for support. */
function maskDetails(d?: Record<string, string>) {
  if (!d) return null;
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length > 4 ? `***${v.slice(-4)}` : '***']));
}
