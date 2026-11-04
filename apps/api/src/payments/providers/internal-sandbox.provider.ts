import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { OperationContext, PaymentProvider, ProviderResult, WebhookEvent } from '../provider';

/**
 * Internal payment simulator (no external calls, fictitious money). Implements the same
 * PaymentProvider contract as Paysafe/Nuvei so every platform flow can be exercised end-to-end.
 * Card "tokens" are test card numbers: 4000 0000 0000 0002 declines, anything else approves.
 * Asynchronous methods wait for a signed webhook (POST /api/payments/webhooks/sandbox).
 */
export class InternalSandboxProvider implements PaymentProvider {
  readonly name = 'sandbox';
  readonly mode = 'SANDBOX' as const;
  private readonly outcomes = new Map<string, 'COMPLETED' | 'FAILED'>();

  constructor(private readonly secret: string, private readonly enabled = true) {}

  isConfigured() {
    return this.enabled;
  }
  supports() {
    return true;
  }

  async createDeposit(ctx: OperationContext): Promise<ProviderResult> {
    const providerRef = `sbx_${randomUUID()}`;
    switch (ctx.method) {
      case 'CREDIT_CARD':
      case 'DEBIT_CARD': {
        const n = (ctx.paymentToken ?? '4242424242424242').replace(/\s/g, '');
        if (n === '4000000000000002') return { status: 'FAILED', providerRef, providerStatus: 'DECLINED', failureReason: 'CARD_DECLINED' };
        return { status: 'COMPLETED', providerRef, providerStatus: 'COMPLETED' };
      }
      case 'PIX':
        return this.pending(providerRef, { pixCopyPaste: `00020126SANDBOX-ATHOSBET-${providerRef.slice(4, 16)}5204000053039865802BR6304ABCD`, expiresInMinutes: '30' });
      case 'BOLETO':
        return this.pending(providerRef, { digitableLine: '00190.00009 01234.567890 12345.678901 1 00000000000000', dueInDays: '3' });
      case 'BANK_TRANSFER':
        return this.pending(providerRef, { iban: 'XX00 SAND BOX0 0000 0000 00', reference: providerRef.slice(4, 14).toUpperCase() });
      case 'CRYPTO':
        return this.pending(providerRef, { asset: 'BTC', network: 'bitcoin-testnet', address: 'tb1qsandboxathosbet0000000000000000000000', confirmations: '2' });
    }
  }

  private pending(providerRef: string, instructions: Record<string, string>): ProviderResult {
    return { status: 'REQUIRES_ACTION', providerRef, providerStatus: 'AWAITING_PAYMENT', nextAction: { type: 'DISPLAY_INSTRUCTIONS', instructions } };
  }

  async createPayout(): Promise<ProviderResult> {
    return { status: 'COMPLETED', providerRef: `sbx_po_${randomUUID()}`, providerStatus: 'COMPLETED' };
  }
  async refund(): Promise<ProviderResult> {
    return { status: 'COMPLETED', providerRef: `sbx_rf_${randomUUID()}`, providerStatus: 'COMPLETED' };
  }

  async sync(ctx: OperationContext): Promise<ProviderResult> {
    const o = this.outcomes.get(ctx.paymentId);
    if (!o) return { status: ctx.providerRef ? 'REQUIRES_ACTION' : 'PENDING', providerRef: ctx.providerRef ?? undefined };
    return { status: o, providerRef: ctx.providerRef ?? undefined, providerStatus: o, failureReason: o === 'FAILED' ? 'PROVIDER_FAILED' : undefined };
  }

  sign(rawBody: string) {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookEvent | null {
    const sig = headers['x-sandbox-signature'];
    if (!sig) return null;
    const a = Buffer.from(this.sign(rawBody));
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const evt = JSON.parse(rawBody) as { id: string; type: string; merchantRef?: string; providerRef?: string };
    // the simulator's "remote state" is driven by its own signed webhooks
    if (evt.merchantRef) this.outcomes.set(evt.merchantRef, evt.type === 'payment.succeeded' ? 'COMPLETED' : 'FAILED');
    return { eventId: evt.id, merchantRef: evt.merchantRef, providerRef: evt.providerRef, type: evt.type };
  }
}
