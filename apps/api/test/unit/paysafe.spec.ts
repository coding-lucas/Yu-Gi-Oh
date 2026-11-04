import { PaysafeClient, PaysafeError } from '../../src/payments/providers/paysafe/paysafe.client';
import { mapTransactionStatus, PaysafeProvider } from '../../src/payments/providers/paysafe/paysafe.provider';
import { FakePaysafe } from '../fakes/fake-paysafe';
import { loadConfig } from '../../src/config';

const cfg = (fake: FakePaysafe, extra: Record<string, unknown> = {}) => new PaysafeProvider({
  env: 'test', username: fake.user, password: fake.pass, webhookHmacKey: fake.hmacKey, signatureHeader: 'signature', singleUseToken: 'public-key',
  accounts: { 'PIX:BRL': '1001', 'CREDIT_CARD:BRL': '1002', 'BANK_TRANSFER:BRL': '1003' }, paymentTypes: {}, returnBaseUrl: 'https://app.athosbet.dev', fetch: fake.fetch, ...extra,
});
const ctx = (over: Record<string, unknown> = {}) => ({
  paymentId: '11111111-1111-4111-8111-111111111111', method: 'PIX' as const, amount: 5000n, currency: 'BRL', country: 'BR',
  customer: { id: 'u1', email: 'u@x.dev', ip: '1.2.3.4', displayName: 'U' }, ...over,
});

describe('Paysafe client & provider', () => {
  it('uses the sandbox base URL and Basic auth', async () => {
    expect(PaysafeClient.baseUrlFor('test')).toBe('https://api.test.paysafe.com/paymenthub/v1');
    expect(PaysafeClient.baseUrlFor('live')).toBe('https://api.paysafe.com/paymenthub/v1');
    const fake = new FakePaysafe();
    const bad = new PaysafeClient({ baseUrl: PaysafeClient.baseUrlFor('test'), username: 'x', password: 'y', fetch: fake.fetch });
    await expect(bad.getPayment('nope')).rejects.toMatchObject({ httpStatus: 401, code: '5279', retryable: false });
  });

  it('retries transient failures with back-off and surfaces definitive errors', async () => {
    let n = 0;
    const flaky: typeof fetch = async () => (++n < 3 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ id: 'p1', status: 'COMPLETED' }), { status: 200 }));
    const c = new PaysafeClient({ baseUrl: 'https://x', username: 'a', password: 'b', fetch: flaky });
    await expect(c.getPayment('p1')).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(n).toBe(3);
    const net = new PaysafeClient({ baseUrl: 'https://x', username: 'a', password: 'b', maxRetries: 1, fetch: (async () => { throw new Error('ECONNRESET'); }) as any });
    await expect(net.getPayment('p')).rejects.toBeInstanceOf(PaysafeError);
  });

  it('maps statuses', () => {
    expect(mapTransactionStatus('COMPLETED')).toBe('COMPLETED');
    expect(mapTransactionStatus('PROCESSING')).toBe('PENDING');
    expect(mapTransactionStatus('HELD')).toBe('PENDING');
    expect(mapTransactionStatus('FAILED')).toBe('FAILED');
    expect(mapTransactionStatus('CANCELLED')).toBe('CANCELLED');
  });

  it('PIX: creates a payment handle and returns the redirect; never processes before PAYABLE', async () => {
    const fake = new FakePaysafe();
    const p = cfg(fake);
    const r = await p.createDeposit(ctx());
    expect(r.status).toBe('REQUIRES_ACTION');
    expect(r.nextAction?.url).toMatch(/hosted\.test\.paysafe\.com/);
    const handleCall = fake.calls.find((c) => c.path === '/paymenthandles')!.body;
    expect(handleCall).toMatchObject({ transactionType: 'PAYMENT', paymentType: 'PIX', amount: 5000, currencyCode: 'BRL', accountId: '1001' });
    expect(handleCall.returnLinks.map((l: any) => l.rel)).toEqual(['default', 'on_completed', 'on_failed']);
    expect(fake.payments.size).toBe(0);
    fake.pay(r.handleId!);
    const s = await p.sync({ ...ctx(), handleId: r.handleId, direction: 'DEPOSIT' });
    expect(s).toMatchObject({ status: 'COMPLETED' });
    const pay = fake.calls.find((c) => c.path === '/payments' && c.method === 'POST')!.body;
    expect(pay).toMatchObject({ merchantRefNum: ctx().paymentId, dupCheck: true, settleWithAuth: true });
  });

  it('cards: never handles raw card data — asks for client-side tokenisation', async () => {
    const fake = new FakePaysafe();
    const r = await cfg(fake).createDeposit(ctx({ method: 'CREDIT_CARD' }));
    expect(r.status).toBe('REQUIRES_ACTION');
    expect(r.nextAction).toMatchObject({ type: 'TOKENIZE_CARD', sdk: { environment: 'TEST', apiKey: 'public-key', accountId: '1002', paymentType: 'CARD' } });
    expect(JSON.stringify(r.nextAction)).not.toContain(fake.pass);
    expect(fake.calls).toHaveLength(0);
  });

  it('a lost response is recovered through dupCheck + lookup by merchantRefNum (no double charge)', async () => {
    const fake = new FakePaysafe();
    fake.loseNextResponses = 1;
    const r = await cfg(fake).createDeposit(ctx({ method: 'CREDIT_CARD', paymentToken: 'PHtoken-card-1' }));
    expect(r.status).toBe('COMPLETED');
    expect(fake.payments.size).toBe(1);
  });

  it('missing merchant account is a definitive configuration error', async () => {
    const fake = new FakePaysafe();
    await expect(cfg(fake).createDeposit(ctx({ method: 'BOLETO' }))).rejects.toMatchObject({ code: 'NO_ACCOUNT', retryable: false });
  });

  it('verifies webhook HMAC signatures in constant time and extracts the merchant reference', () => {
    const fake = new FakePaysafe();
    const p = cfg(fake);
    const { raw, signature } = fake.webhook({ id: 'evt1', eventName: 'PAYMENT_HANDLE_PAYABLE', payload: { id: 'h1', merchantRefNum: `${ctx().paymentId}-h` } });
    expect(p.parseWebhook(raw, { signature })).toEqual({ eventId: 'evt1', merchantRef: ctx().paymentId, providerRef: 'h1', type: 'PAYMENT_HANDLE_PAYABLE' });
    expect(p.parseWebhook(raw, { signature: signature.replace(/.$/, signature.endsWith('A') ? 'B' : 'A') })).toBeNull();
    expect(p.parseWebhook(raw + ' ', { signature })).toBeNull();
    expect(p.parseWebhook(raw, {})).toBeNull();
    expect(cfg(fake, { webhookHmacKey: undefined }).parseWebhook(raw, { signature })).toBeNull();
  });

  it('is not configured without credentials and webhook key', () => {
    expect(new PaysafeProvider({ env: 'test', signatureHeader: 'signature', accounts: {}, paymentTypes: {}, returnBaseUrl: 'x' }).isConfigured()).toBe(false);
  });

  it('refuses the live environment unless real money is legally enabled', () => {
    expect(() => loadConfig({ PAYSAFE_ENV: 'live' } as any)).toThrow(/REAL_MONEY_ENABLED/);
    expect(loadConfig({} as any).PAYSAFE_ENV).toBe('test');
  });
});
