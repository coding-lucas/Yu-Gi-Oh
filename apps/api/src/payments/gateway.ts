import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type PaymentMethod = 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'BOLETO' | 'BANK_TRANSFER' | 'BTC' | 'SANDBOX';
export const PAYMENT_METHODS: PaymentMethod[] = ['PIX', 'CREDIT_CARD', 'DEBIT_CARD', 'BOLETO', 'BANK_TRANSFER', 'BTC'];

export interface GatewayDepositResult {
  providerRef: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  /** instructions shown to the player (PIX copy-paste code, boleto line, BTC address, 3DS URL…) */
  instructions?: Record<string, string>;
  failureReason?: string;
}

export interface PaymentGateway {
  readonly name: string;
  readonly mode: 'SANDBOX' | 'REAL';
  supports(method: PaymentMethod, country: string): boolean;
  createDeposit(p: { paymentId: string; amount: bigint; currency: string; method: PaymentMethod; card?: { number: string } }): Promise<GatewayDepositResult>;
  createPayout(p: { paymentId: string; amount: bigint; currency: string; method: PaymentMethod }): Promise<GatewayDepositResult>;
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
}

/**
 * Sandbox gateway: simulates every method end-to-end with fictitious money. Card numbers follow the
 * usual test conventions: 4000 0000 0000 0002 is declined, anything else is approved. PIX, boleto,
 * bank transfer and BTC are asynchronous: they return instructions and are confirmed by a signed
 * webhook (POST /payments/webhooks/sandbox), which can be triggered from the UI "simulate payment".
 */
export class SandboxGateway implements PaymentGateway {
  readonly name = 'sandbox';
  readonly mode = 'SANDBOX' as const;
  constructor(private readonly secret: string) {}

  supports(): boolean {
    return true;
  }

  async createDeposit(p: { paymentId: string; amount: bigint; currency: string; method: PaymentMethod; card?: { number: string } }): Promise<GatewayDepositResult> {
    const providerRef = `sbx_${randomUUID()}`;
    switch (p.method) {
      case 'CREDIT_CARD':
      case 'DEBIT_CARD': {
        const n = (p.card?.number ?? '4242424242424242').replace(/\s/g, '');
        if (n === '4000000000000002') return { providerRef, status: 'FAILED', failureReason: 'CARD_DECLINED' };
        return { providerRef, status: 'COMPLETED' };
      }
      case 'PIX':
        return { providerRef, status: 'PENDING', instructions: { pixCopyPaste: `00020126SANDBOX-ATHOSBET-${providerRef.slice(4, 16)}5204000053039865802BR6304ABCD`, expiresInMinutes: '30' } };
      case 'BOLETO':
        return { providerRef, status: 'PENDING', instructions: { digitableLine: '00190.00009 01234.567890 12345.678901 1 00000000000000', dueInDays: '3' } };
      case 'BANK_TRANSFER':
        return { providerRef, status: 'PENDING', instructions: { iban: 'XX00 SAND BOX0 0000 0000 00', reference: providerRef.slice(4, 14).toUpperCase() } };
      case 'BTC':
        return { providerRef, status: 'PENDING', instructions: { address: 'tb1qsandboxathosbet0000000000000000000000', network: 'bitcoin-testnet', confirmations: '2' } };
      default:
        return { providerRef, status: 'COMPLETED' };
    }
  }

  async createPayout(): Promise<GatewayDepositResult> {
    return { providerRef: `sbx_po_${randomUUID()}`, status: 'COMPLETED' };
  }

  sign(rawBody: string) {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  verifyWebhook(rawBody: string, signature: string | undefined) {
    if (!signature) return false;
    const exp = Buffer.from(this.sign(rawBody));
    const got = Buffer.from(signature);
    return exp.length === got.length && timingSafeEqual(exp, got);
  }
}

/**
 * Placeholders for real providers that explicitly accept licensed gambling merchants
 * (e.g. Nuvei, Paysafe). They are intentionally disabled: activation requires a signed merchant
 * agreement, an operating licence for the target market and REAL_MONEY_ENABLED=true. The
 * merchant descriptor must identify the activity as gambling (MCC 7995) — never disguise it.
 */
export class DisabledRealGateway implements PaymentGateway {
  readonly mode = 'REAL' as const;
  constructor(readonly name: 'nuvei' | 'paysafe') {}
  supports() {
    return false;
  }
  async createDeposit(): Promise<GatewayDepositResult> {
    throw new Error(`${this.name} gateway is not activated`);
  }
  async createPayout(): Promise<GatewayDepositResult> {
    throw new Error(`${this.name} gateway is not activated`);
  }
  verifyWebhook() {
    return false;
  }
}

/** Where each method could legally/commercially be offered once licensed (to be confirmed by legal). */
export const METHOD_MARKETS: Record<PaymentMethod, string[] | '*'> = {
  PIX: ['BR'],
  BOLETO: ['BR'],
  CREDIT_CARD: '*',
  DEBIT_CARD: '*',
  BANK_TRANSFER: '*',
  BTC: [],
  SANDBOX: '*',
};
