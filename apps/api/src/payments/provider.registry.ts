import { Injectable } from '@nestjs/common';
import { config } from '../config';
import { PaymentProvider } from './provider';
import { InternalSandboxProvider } from './providers/internal-sandbox.provider';
import { PaysafeProvider } from './providers/paysafe/paysafe.provider';
import { NuveiProvider } from './providers/nuvei.provider';

function json<T>(s: string, name: string): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

export function buildProviders(fetchImpl?: typeof fetch): PaymentProvider[] {
  const c = config();
  return [
    new PaysafeProvider({
      env: c.PAYSAFE_ENV, baseUrl: c.PAYSAFE_BASE_URL, username: c.PAYSAFE_API_USERNAME, password: c.PAYSAFE_API_PASSWORD,
      singleUseToken: c.PAYSAFE_SINGLE_USE_TOKEN, webhookHmacKey: c.PAYSAFE_WEBHOOK_HMAC_KEY, signatureHeader: c.PAYSAFE_SIGNATURE_HEADER,
      accounts: json(c.PAYSAFE_ACCOUNTS, 'PAYSAFE_ACCOUNTS'), paymentTypes: json(c.PAYSAFE_PAYMENT_TYPES, 'PAYSAFE_PAYMENT_TYPES'),
      returnBaseUrl: c.PUBLIC_APP_URL, fetch: fetchImpl,
    }),
    new NuveiProvider({ merchantId: c.NUVEI_MERCHANT_ID, siteId: c.NUVEI_MERCHANT_SITE_ID, secret: c.NUVEI_SECRET_KEY }),
    new InternalSandboxProvider(c.SANDBOX_WEBHOOK_SECRET, c.INTERNAL_SANDBOX_PROVIDER && !c.REAL_MONEY_ENABLED),
  ];
}

export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');

@Injectable()
export class PaymentProviderRegistry {
  private readonly byName: Map<string, PaymentProvider>;
  constructor(providers: PaymentProvider[]) {
    this.byName = new Map(providers.map((p) => [p.name, p]));
  }
  get(name: string): PaymentProvider | undefined {
    return this.byName.get(name);
  }
  all(): PaymentProvider[] {
    return [...this.byName.values()];
  }
  status() {
    return this.all().map((p) => ({ name: p.name, mode: p.mode, configured: p.isConfigured() }));
  }
}
