import { randomUUID } from 'node:crypto';

/**
 * Thin client for the Paysafe Payments API (Payments Hub v1).
 *   test: https://api.test.paysafe.com/paymenthub/v1   live: https://api.paysafe.com/paymenthub/v1
 * Authentication: HTTP Basic with the merchant API key (username:password).
 * Amounts are integers in the currency's minor units. Paysafe de-duplicates requests by
 * merchantRefNum when dupCheck=true, which makes retries of POSTs safe.
 *
 * NOTE: endpoint shapes follow the public Payments API reference; field-level details (e.g. the
 * exact paymentType names for PIX / Boleto / Pay with Crypto in a given merchant set-up) must be
 * confirmed during Paysafe homologation and are configurable (PAYSAFE_PAYMENT_TYPES).
 */
export class PaysafeError extends Error {
  constructor(public readonly httpStatus: number, public readonly code: string | undefined, message: string, public readonly retryable: boolean, public readonly body?: unknown) {
    super(`Paysafe ${httpStatus}${code ? ` ${code}` : ''}: ${message}`);
  }
}

export interface PaysafeClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** test environment only: lets Paysafe's APM simulator drive redirects/webhooks */
  simulator?: boolean;
  fetch?: typeof fetch;
  onCall?: (c: { method: string; path: string; status: number; ms: number; correlationId: string }) => void;
}

export interface PaysafePaymentHandle {
  id: string;
  paymentHandleToken: string;
  merchantRefNum: string;
  status: 'INITIATED' | 'PAYABLE' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | string;
  action?: 'NONE' | 'REDIRECT' | string;
  links?: { rel: string; href: string }[];
  paymentType: string;
  [k: string]: unknown;
}

export interface PaysafeTransaction {
  id: string;
  merchantRefNum: string;
  amount: number;
  currencyCode: string;
  status: 'RECEIVED' | 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'HELD' | string;
  error?: { code?: string; message?: string };
  [k: string]: unknown;
}

export class PaysafeClient {
  private readonly http: typeof fetch;
  constructor(private readonly o: PaysafeClientOptions) {
    this.http = o.fetch ?? fetch;
  }

  static baseUrlFor(env: 'test' | 'live') {
    return env === 'live' ? 'https://api.paysafe.com/paymenthub/v1' : 'https://api.test.paysafe.com/paymenthub/v1';
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.o.username}:${this.o.password}`).toString('base64');
    const max = this.o.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const correlationId = randomUUID();
      const t = Date.now();
      let res: Response;
      try {
        res = await this.http(`${this.o.baseUrl}${path}`, {
          method,
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json', 'X-Correlation-Id': correlationId, ...(this.o.simulator ? { Simulator: 'EXTERNAL' } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
        });
      } catch (e: any) {
        if (attempt < max) { await sleep(250 * 2 ** attempt); continue; }
        throw new PaysafeError(0, 'NETWORK', e?.message ?? String(e), true);
      }
      this.o.onCall?.({ method, path, status: res.status, ms: Date.now() - t, correlationId });
      const text = await res.text();
      const json = text ? safeJson(text) : {};
      if (res.ok) return json as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < max) { await sleep(250 * 2 ** attempt); continue; }
      const err = (json as any)?.error ?? {};
      throw new PaysafeError(res.status, err.code, err.message ?? res.statusText ?? 'error', retryable, json);
    }
  }

  createPaymentHandle(body: Record<string, unknown>) {
    return this.request<PaysafePaymentHandle>('POST', '/paymenthandles', body);
  }
  getPaymentHandle(id: string) {
    return this.request<PaysafePaymentHandle>('GET', `/paymenthandles/${encodeURIComponent(id)}`);
  }
  processPayment(body: Record<string, unknown>) {
    return this.request<PaysafeTransaction>('POST', '/payments', body);
  }
  getPayment(id: string) {
    return this.request<PaysafeTransaction>('GET', `/payments/${encodeURIComponent(id)}`);
  }
  findPayments(merchantRefNum: string) {
    return this.request<{ payments?: PaysafeTransaction[] }>('GET', `/payments?merchantRefNum=${encodeURIComponent(merchantRefNum)}`);
  }
  findStandaloneCredits(merchantRefNum: string) {
    return this.request<{ standaloneCredits?: PaysafeTransaction[] }>('GET', `/standalonecredits?merchantRefNum=${encodeURIComponent(merchantRefNum)}`);
  }
  findRefunds(merchantRefNum: string) {
    return this.request<{ refunds?: PaysafeTransaction[] }>('GET', `/refunds?merchantRefNum=${encodeURIComponent(merchantRefNum)}`);
  }
  standaloneCredit(body: Record<string, unknown>) {
    return this.request<PaysafeTransaction>('POST', '/standalonecredits', body);
  }
  getStandaloneCredit(id: string) {
    return this.request<PaysafeTransaction>('GET', `/standalonecredits/${encodeURIComponent(id)}`);
  }
  /** For settleWithAuth payments the settlement id equals the payment id. */
  refund(settlementId: string, body: Record<string, unknown>) {
    return this.request<PaysafeTransaction>('POST', `/settlements/${encodeURIComponent(settlementId)}/refunds`, body);
  }
  getRefund(id: string) {
    return this.request<PaysafeTransaction>('GET', `/refunds/${encodeURIComponent(id)}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}
