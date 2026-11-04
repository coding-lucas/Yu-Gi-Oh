/**
 * PaymentProvider — the only contract the platform core knows about. Paysafe (primary), Nuvei
 * (secondary) and the internal simulator implement it; adding a provider means implementing this
 * interface and registering it in PaymentProviderRegistry — no change to ledger, wallet or
 * settlement logic.
 */
export type PaymentMethod = 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'BOLETO' | 'BANK_TRANSFER' | 'CRYPTO';
export const PAYMENT_METHODS: PaymentMethod[] = ['PIX', 'CREDIT_CARD', 'DEBIT_CARD', 'BOLETO', 'BANK_TRANSFER', 'CRYPTO'];
export type PaymentDirection = 'DEPOSIT' | 'WITHDRAWAL' | 'REFUND';
export type ProviderMode = 'SANDBOX' | 'REAL';

/** Normalised provider-side state of an operation. */
export type ProviderStatus = 'PENDING' | 'REQUIRES_ACTION' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface NextAction {
  type: 'REDIRECT' | 'DISPLAY_INSTRUCTIONS' | 'TOKENIZE_CARD';
  url?: string;
  instructions?: Record<string, string>;
  /** data needed by the client-side tokenisation SDK (no secrets) */
  sdk?: Record<string, string | number>;
}

export interface ProviderResult {
  status: ProviderStatus;
  /** provider id of the money-moving object (payment / standalone credit / refund) */
  providerRef?: string;
  /** provider id of the intermediate object (e.g. Paysafe payment handle) */
  handleId?: string;
  providerStatus?: string;
  nextAction?: NextAction | null;
  failureReason?: string;
  raw?: unknown;
}

export interface OperationContext {
  paymentId: string; // also used as merchant reference → provider-side idempotency
  method: PaymentMethod;
  amount: bigint; // provider minor units
  currency: string; // provider currency (ISO 4217)
  country: string;
  customer: { id: string; email: string; ip: string | null; displayName: string };
  returnUrl?: string;
  /** client-side token (e.g. Paysafe.js payment handle token) — raw card data never reaches the backend */
  paymentToken?: string;
  /** payout instrument (PIX key, bank account…) for withdrawals */
  payoutDetails?: Record<string, string>;
  /** provider ref of the original deposit for refunds */
  originalProviderRef?: string;
  /** provider ref of the operation when re-synchronising */
  providerRef?: string | null;
  handleId?: string | null;
  sandboxTest?: { simulate?: 'APPROVE' | 'DECLINE' };
}

export interface WebhookEvent {
  eventId: string;
  /** our payment id (merchant reference) when present in the payload */
  merchantRef?: string;
  providerRef?: string;
  type: string;
}

export interface PaymentProvider {
  readonly name: string;
  readonly mode: ProviderMode;
  /** technical capability (credentials, account configured). Commercial/legal eligibility is checked separately. */
  isConfigured(): boolean;
  supports(method: PaymentMethod, direction: PaymentDirection): boolean;
  createDeposit(ctx: OperationContext): Promise<ProviderResult>;
  createPayout(ctx: OperationContext): Promise<ProviderResult>;
  refund(ctx: OperationContext): Promise<ProviderResult>;
  /**
   * Authoritative status lookup (used after webhooks and by the reconciliation job). May advance a
   * multi-step flow (e.g. Paysafe: payable handle → process payment) idempotently.
   */
  sync(ctx: OperationContext & { direction: PaymentDirection }): Promise<ProviderResult>;
  /** Verifies authenticity (signature) and extracts identifiers; never trusts the payload for amounts/status. */
  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookEvent | null;
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`payment provider ${provider} is not configured`);
  }
}
