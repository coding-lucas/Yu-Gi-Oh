import { createHmac, randomUUID } from 'node:crypto';

/**
 * In-memory stand-in for the Paysafe Payments API used by tests (sandbox behaviour only).
 * Implements: payment handles, payments, standalone credits, refunds, lookups by merchantRefNum,
 * Basic-auth check, dupCheck (error 5031), injectable failures and lost responses, signed webhooks.
 */
export class FakePaysafe {
  handles = new Map<string, any>();
  payments = new Map<string, any>();
  credits = new Map<string, any>();
  refunds = new Map<string, any>();
  calls: { method: string; path: string; body?: any }[] = [];
  /** paymentTypes whose handle starts INITIATED with a REDIRECT (customer action required) */
  redirectTypes = new Set(['PIX', 'BOLETO', 'PAY_BY_BANK', 'CRYPTO']);
  declineTokens = new Set<string>();
  /** number of upcoming POST /payments that are processed but whose response is "lost" (503) */
  loseNextResponses = 0;
  failCredits = false;
  constructor(public readonly user = 'test_user', public readonly pass = 'B-qa2-0-secret', public readonly hmacKey = 'webhook-hmac-key') {}

  readonly fetch: typeof fetch = async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/paymenthub\/v1/, '');
    this.calls.push({ method, path: path + url.search, body });
    const auth = init?.headers?.Authorization;
    if (auth !== `Basic ${Buffer.from(`${this.user}:${this.pass}`).toString('base64')}`) return json(401, { error: { code: '5279', message: 'Invalid credentials' } });
    const ref = url.searchParams.get('merchantRefNum');
    const dup = (m: Map<string, any>, r: string) => [...m.values()].find((x) => x.merchantRefNum === r);
    let mm: RegExpMatchArray | null;

    if (method === 'POST' && path === '/paymenthandles') {
      if (dup(this.handles, body.merchantRefNum)) return json(409, { error: { code: '5031', message: 'duplicate' } });
      const id = randomUUID();
      const redirect = this.redirectTypes.has(body.paymentType) && body.transactionType === 'PAYMENT';
      const h = { id, paymentHandleToken: `PH${id.replace(/-/g, '').slice(0, 20)}`, ...body, status: redirect ? 'INITIATED' : 'PAYABLE', action: redirect ? 'REDIRECT' : 'NONE', links: redirect ? [{ rel: 'redirect_payment', href: `https://hosted.test.paysafe.com/pay/${id}` }] : [] };
      this.handles.set(id, h);
      return json(201, h);
    }
    if (method === 'GET' && (mm = path.match(/^\/paymenthandles\/(.+)$/))) return this.handles.has(mm[1]) ? json(200, this.handles.get(mm[1])) : json(404, { error: { code: '5269', message: 'not found' } });
    if (method === 'POST' && path === '/payments') {
      const existing = dup(this.payments, body.merchantRefNum);
      if (existing && body.dupCheck) return json(409, { error: { code: '5031', message: 'The transaction you have submitted has already been processed' } });
      const h = [...this.handles.values()].find((x) => x.paymentHandleToken === body.paymentHandleToken);
      const declined = this.declineTokens.has(body.paymentHandleToken);
      if (h) h.status = 'COMPLETED';
      const p = { id: randomUUID(), merchantRefNum: body.merchantRefNum, amount: body.amount, currencyCode: body.currencyCode, status: declined ? 'FAILED' : 'COMPLETED', ...(declined ? { error: { code: '3009', message: 'declined' } } : {}) };
      this.payments.set(p.id, p);
      if (this.loseNextResponses > 0) { this.loseNextResponses--; return json(503, { error: { code: '1000', message: 'lost' } }); }
      if (declined) return json(402, { ...p, error: p.error });
      return json(201, p);
    }
    if (method === 'GET' && path === '/payments') return json(200, { payments: [...this.payments.values()].filter((x) => x.merchantRefNum === ref) });
    if (method === 'GET' && (mm = path.match(/^\/payments\/(.+)$/))) return this.payments.has(mm[1]) ? json(200, this.payments.get(mm[1])) : json(404, { error: { code: '5269' } });
    if (method === 'POST' && path === '/standalonecredits') {
      if (dup(this.credits, body.merchantRefNum)) return json(409, { error: { code: '5031' } });
      const c = { id: randomUUID(), merchantRefNum: body.merchantRefNum, amount: body.amount, currencyCode: body.currencyCode, status: this.failCredits ? 'FAILED' : 'COMPLETED' };
      this.credits.set(c.id, c);
      return json(201, c);
    }
    if (method === 'GET' && path === '/standalonecredits') return json(200, { standaloneCredits: [...this.credits.values()].filter((x) => x.merchantRefNum === ref) });
    if (method === 'GET' && (mm = path.match(/^\/standalonecredits\/(.+)$/))) return json(200, this.credits.get(mm[1]));
    if (method === 'POST' && (mm = path.match(/^\/settlements\/(.+)\/refunds$/))) {
      const p = this.payments.get(mm[1]);
      if (!p || p.status !== 'COMPLETED') return json(400, { error: { code: '3406', message: 'not refundable' } });
      const total = [...this.refunds.values()].filter((r) => r.settlementId === p.id).reduce((s, r) => s + r.amount, 0);
      if (total + body.amount > p.amount) return json(400, { error: { code: '3407', message: 'exceeds' } });
      if (dup(this.refunds, body.merchantRefNum)) return json(409, { error: { code: '5031' } });
      const r = { id: randomUUID(), settlementId: p.id, merchantRefNum: body.merchantRefNum, amount: body.amount, status: 'COMPLETED' };
      this.refunds.set(r.id, r);
      return json(201, r);
    }
    if (method === 'GET' && path === '/refunds') return json(200, { refunds: [...this.refunds.values()].filter((x) => x.merchantRefNum === ref) });
    if (method === 'GET' && (mm = path.match(/^\/refunds\/(.+)$/))) return json(200, this.refunds.get(mm[1]));
    return json(404, { error: { code: '5269', message: `no route ${method} ${path}` } });
  };

  /** Simulates the customer completing the redirect (PIX paid, boleto paid…). */
  pay(handleId: string) {
    this.handles.get(handleId).status = 'PAYABLE';
  }

  webhook(event: Record<string, unknown>) {
    const raw = JSON.stringify(event);
    return { raw, signature: createHmac('sha256', this.hmacKey).update(raw).digest('base64') };
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
