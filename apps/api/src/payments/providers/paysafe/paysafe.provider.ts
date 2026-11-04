import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import {
  NextAction, OperationContext, PaymentDirection, PaymentMethod, PaymentProvider, ProviderMode, ProviderResult, ProviderStatus, WebhookEvent,
} from '../../provider';
import { PaysafeClient, PaysafeError, PaysafePaymentHandle, PaysafeTransaction } from './paysafe.client';

/**
 * Default AthosBet method → Paysafe paymentType mapping. CARD is the documented card type; the
 * local/alternative payment types depend on what Paysafe enables for the merchant account and
 * MUST be confirmed during homologation (override with PAYSAFE_PAYMENT_TYPES).
 */
export const DEFAULT_PAYSAFE_PAYMENT_TYPES: Record<PaymentMethod, string> = {
  CREDIT_CARD: 'CARD',
  DEBIT_CARD: 'CARD',
  PIX: 'PIX',
  BOLETO: 'BOLETO',
  BANK_TRANSFER: 'PAY_BY_BANK',
  CRYPTO: 'CRYPTO',
};

export interface PaysafeProviderConfig {
  env: 'test' | 'live';
  baseUrl?: string;
  username?: string;
  password?: string;
  singleUseToken?: string;
  webhookHmacKey?: string;
  signatureHeader: string;
  accounts: Record<string, string>; // "METHOD:CURRENCY" -> accountId
  paymentTypes: Partial<Record<PaymentMethod, string>>;
  returnBaseUrl: string;
  fetch?: typeof fetch;
}

export function mapTransactionStatus(s: string | undefined): ProviderStatus {
  switch (s) {
    case 'COMPLETED': return 'COMPLETED';
    case 'FAILED': case 'ERROR': return 'FAILED';
    case 'CANCELLED': case 'EXPIRED': return 'CANCELLED';
    default: return 'PENDING'; // RECEIVED, PENDING, PROCESSING, HELD…
  }
}

/** Paysafe error code for a duplicate merchantRefNum when dupCheck=true (request already processed). */
export const PAYSAFE_DUPLICATE_CODES = new Set(['5031']);

export class PaysafeProvider implements PaymentProvider {
  readonly name = 'paysafe';
  readonly mode: ProviderMode;
  private readonly client: PaysafeClient | null;
  private readonly types: Record<PaymentMethod, string>;

  constructor(private readonly cfg: PaysafeProviderConfig) {
    this.mode = cfg.env === 'live' ? 'REAL' : 'SANDBOX';
    this.types = { ...DEFAULT_PAYSAFE_PAYMENT_TYPES, ...cfg.paymentTypes };
    this.client = cfg.username && cfg.password
      ? new PaysafeClient({ baseUrl: cfg.baseUrl ?? PaysafeClient.baseUrlFor(cfg.env), username: cfg.username, password: cfg.password, fetch: cfg.fetch, simulator: cfg.env === 'test' })
      : null;
  }

  isConfigured() {
    return !!this.client && !!this.cfg.webhookHmacKey;
  }

  supports(method: PaymentMethod, direction: PaymentDirection) {
    if (direction === 'REFUND') return method !== 'BOLETO'; // boleto refunds are paid out as credits
    return !!this.types[method];
  }

  private api() {
    if (!this.client) throw new PaysafeError(0, 'NOT_CONFIGURED', 'Paysafe credentials missing', false);
    return this.client;
  }

  private account(method: PaymentMethod, currency: string) {
    const id = this.cfg.accounts[`${method}:${currency}`] ?? this.cfg.accounts[`*:${currency}`];
    if (!id) throw new PaysafeError(0, 'NO_ACCOUNT', `no Paysafe account configured for ${method}:${currency}`, false);
    return id;
  }

  private returnLinks(ctx: OperationContext) {
    const base = ctx.returnUrl ?? `${this.cfg.returnBaseUrl}/wallet?payment=${ctx.paymentId}`;
    return [
      { rel: 'default', href: base, method: 'GET' },
      { rel: 'on_completed', href: `${base}&result=completed`, method: 'GET' },
      { rel: 'on_failed', href: `${base}&result=failed`, method: 'GET' },
    ];
  }

  private handleResult(h: PaysafePaymentHandle): ProviderResult {
    if (h.status === 'FAILED') return { status: 'FAILED', handleId: h.id, providerStatus: `HANDLE_${h.status}`, failureReason: 'PAYMENT_HANDLE_FAILED' };
    if (h.status === 'EXPIRED') return { status: 'CANCELLED', handleId: h.id, providerStatus: `HANDLE_${h.status}`, failureReason: 'PAYMENT_HANDLE_EXPIRED' };
    const redirect = h.links?.find((l) => l.rel === 'redirect_payment' || l.rel === 'redirect')?.href;
    const next: NextAction | null = h.action === 'REDIRECT' && redirect ? { type: 'REDIRECT', url: redirect } : null;
    return { status: next ? 'REQUIRES_ACTION' : 'PENDING', handleId: h.id, providerStatus: `HANDLE_${h.status}`, nextAction: next };
  }

  private txResult(t: PaysafeTransaction, handleId?: string): ProviderResult {
    return { status: mapTransactionStatus(t.status), providerRef: t.id, handleId, providerStatus: t.status, failureReason: t.error?.code ?? (t.status === 'FAILED' ? 'PROVIDER_FAILED' : undefined) };
  }

  /**
   * A retried POST whose first attempt actually succeeded (lost response) is rejected by Paysafe as a
   * duplicate merchantRefNum; the original transaction is then looked up instead of failing.
   */
  private async dedup<T>(fn: () => Promise<T>, lookup: () => Promise<T | undefined>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PaysafeError && e.code && PAYSAFE_DUPLICATE_CODES.has(e.code)) {
        const found = await lookup();
        if (found) return found;
      }
      throw e;
    }
  }

  private processPayment(ctx: OperationContext, token: string, handleId?: string) {
    return this.dedup(() => this.api().processPayment({
      merchantRefNum: ctx.paymentId,
      amount: Number(ctx.amount),
      currencyCode: ctx.currency,
      dupCheck: true,
      settleWithAuth: true,
      paymentHandleToken: token,
      customerIp: ctx.customer.ip ?? undefined,
      description: 'AthosBet account deposit',
    }), () => this.api().findPayments(ctx.paymentId).then((r) => r.payments?.[0])).then((t) => this.txResult(t, handleId));
  }

  async createDeposit(ctx: OperationContext): Promise<ProviderResult> {
    const paymentType = this.types[ctx.method];
    if (paymentType === 'CARD') {
      // PCI DSS: card data is tokenised in the browser by Paysafe.js; the backend only sees the handle token.
      if (!ctx.paymentToken) {
        return {
          status: 'REQUIRES_ACTION',
          nextAction: {
            type: 'TOKENIZE_CARD',
            sdk: { environment: this.cfg.env === 'live' ? 'LIVE' : 'TEST', apiKey: this.cfg.singleUseToken ?? '', accountId: this.account(ctx.method, ctx.currency), currencyCode: ctx.currency, amount: Number(ctx.amount), merchantRefNum: ctx.paymentId, transactionType: 'PAYMENT', paymentType: 'CARD' },
          },
        };
      }
      return this.processPayment(ctx, ctx.paymentToken);
    }
    const h = await this.api().createPaymentHandle({
      merchantRefNum: `${ctx.paymentId}-h`,
      transactionType: 'PAYMENT',
      paymentType,
      amount: Number(ctx.amount),
      currencyCode: ctx.currency,
      accountId: this.account(ctx.method, ctx.currency),
      customerIp: ctx.customer.ip ?? undefined,
      profile: { firstName: ctx.customer.displayName, email: ctx.customer.email },
      billingDetails: { country: ctx.country },
      returnLinks: this.returnLinks(ctx),
    });
    if (h.status === 'PAYABLE') return this.processPayment(ctx, h.paymentHandleToken, h.id);
    return this.handleResult(h);
  }

  async createPayout(ctx: OperationContext): Promise<ProviderResult> {
    const paymentType = this.types[ctx.method];
    const h = await this.api().createPaymentHandle({
      merchantRefNum: `${ctx.paymentId}-h`,
      transactionType: 'STANDALONE_CREDIT',
      paymentType,
      amount: Number(ctx.amount),
      currencyCode: ctx.currency,
      accountId: this.account(ctx.method, ctx.currency),
      profile: { firstName: ctx.customer.displayName, email: ctx.customer.email },
      billingDetails: { country: ctx.country },
      ...(ctx.paymentToken ? { paymentHandleToken: ctx.paymentToken } : {}),
      ...(ctx.payoutDetails ? { [paymentTypeKey(paymentType)]: ctx.payoutDetails } : {}),
      returnLinks: this.returnLinks(ctx),
    });
    if (h.status !== 'PAYABLE') return this.handleResult(h);
    return this.credit(ctx, h);
  }

  async refund(ctx: OperationContext): Promise<ProviderResult> {
    if (!ctx.originalProviderRef) throw new PaysafeError(0, 'NO_ORIGINAL', 'refund requires the original Paysafe payment id', false);
    const t = await this.dedup(
      () => this.api().refund(ctx.originalProviderRef!, { merchantRefNum: ctx.paymentId, amount: Number(ctx.amount), dupCheck: true }),
      () => this.api().findRefunds(ctx.paymentId).then((r) => r.refunds?.[0]),
    );
    return this.txResult(t);
  }

  private async credit(ctx: OperationContext, h: PaysafePaymentHandle) {
    const t = await this.dedup(
      () => this.api().standaloneCredit({ merchantRefNum: ctx.paymentId, amount: Number(ctx.amount), currencyCode: ctx.currency, dupCheck: true, paymentHandleToken: h.paymentHandleToken }),
      () => this.api().findStandaloneCredits(ctx.paymentId).then((r) => r.standaloneCredits?.[0]),
    );
    return this.txResult(t, h.id);
  }

  /** Authoritative status; advances PAYABLE handles to a payment/credit exactly once (dupCheck). */
  async sync(ctx: OperationContext & { direction: PaymentDirection }): Promise<ProviderResult> {
    const api = this.api();
    if (ctx.providerRef) {
      const t = ctx.direction === 'DEPOSIT' ? await api.getPayment(ctx.providerRef) : ctx.direction === 'WITHDRAWAL' ? await api.getStandaloneCredit(ctx.providerRef) : await api.getRefund(ctx.providerRef);
      return this.txResult(t, ctx.handleId ?? undefined);
    }
    if (ctx.direction === 'DEPOSIT' && ctx.paymentToken) return this.processPayment(ctx, ctx.paymentToken);
    // the transaction may already exist (lost response) — look it up by merchant reference first
    const found = ctx.direction === 'DEPOSIT'
      ? (await api.findPayments(ctx.paymentId).catch(() => ({ payments: [] as PaysafeTransaction[] }))).payments?.[0]
      : ctx.direction === 'WITHDRAWAL'
        ? (await api.findStandaloneCredits(ctx.paymentId).catch(() => ({ standaloneCredits: [] as PaysafeTransaction[] }))).standaloneCredits?.[0]
        : (await api.findRefunds(ctx.paymentId).catch(() => ({ refunds: [] as PaysafeTransaction[] }))).refunds?.[0];
    if (found) return this.txResult(found, ctx.handleId ?? undefined);
    if (!ctx.handleId) return { status: 'PENDING' };
    const h = await api.getPaymentHandle(ctx.handleId);
    if (h.status === 'PAYABLE') {
      if (ctx.direction === 'DEPOSIT') return this.processPayment(ctx, h.paymentHandleToken, h.id);
      return this.credit(ctx, h);
    }
    return this.handleResult(h);
  }

  /**
   * Webhook authenticity: HMAC-SHA256 of the raw body with the webhook key, base64 encoded, compared in
   * constant time with the signature header. The payload is used only to locate the payment; the
   * status is always re-read from the API (sync), so a forged-but-signed or replayed body cannot move money.
   */
  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookEvent | null {
    const key = this.cfg.webhookHmacKey;
    const sig = headers[this.cfg.signatureHeader.toLowerCase()];
    if (!key || !sig) return null;
    const expected = createHmac('sha256', key).update(rawBody, 'utf8').digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(sig.trim());
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const payload = body.payload ?? body.data ?? body;
    const ref: string | undefined = payload?.merchantRefNum ?? body.merchantRefNum;
    return {
      eventId: String(body.id ?? body.eventId ?? createHash('sha256').update(rawBody).digest('hex')),
      merchantRef: ref?.replace(/-h$/, ''),
      providerRef: payload?.id,
      type: String(body.eventName ?? body.eventType ?? body.type ?? 'UNKNOWN'),
    };
  }

  /** for tests / tooling */
  sign(rawBody: string) {
    return createHmac('sha256', this.cfg.webhookHmacKey ?? '').update(rawBody, 'utf8').digest('base64');
  }
}

function paymentTypeKey(t: string) {
  // Paysafe nests instrument data under a lower-camel key of the payment type (e.g. "card", "pix")
  return t.toLowerCase().replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
}
