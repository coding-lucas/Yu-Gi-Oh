import { auth, createStaff, createTestApp, idem, registerUser, TestCtx } from '../helpers';
import { FakePaysafe } from '../fakes/fake-paysafe';
import { PaysafeProvider } from '../../src/payments/providers/paysafe/paysafe.provider';
import { InternalSandboxProvider } from '../../src/payments/providers/internal-sandbox.provider';
import { NuveiProvider } from '../../src/payments/providers/nuvei.provider';
import { PaymentsService } from '../../src/payments/payments.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { overrideConfig } from '../../src/config';

describe('Paysafe integration (sandbox, fake Paysafe API, real PostgreSQL)', () => {
  let ctx: TestCtx;
  let fake: FakePaysafe;
  let admin: Awaited<ReturnType<typeof createStaff>>;
  const BR = { 'cf-ipcountry': 'BR' };

  beforeAll(async () => {
    overrideConfig({ TRUST_GEO_HEADER: true });
    fake = new FakePaysafe();
    const paysafe = new PaysafeProvider({
      env: 'test', username: fake.user, password: fake.pass, webhookHmacKey: fake.hmacKey, signatureHeader: 'signature', singleUseToken: 'pk_test',
      accounts: { 'PIX:BRL': '1001', 'CREDIT_CARD:BRL': '1002', 'BOLETO:BRL': '1004' }, paymentTypes: {}, returnBaseUrl: 'http://localhost:3000', fetch: fake.fetch,
    });
    ctx = await createTestApp({ league: false, paymentProviders: [paysafe, new NuveiProvider({}), new InternalSandboxProvider('sandbox-webhook-secret')] });
    admin = await createStaff(ctx, 'ADMIN');
  });
  afterAll(async () => { overrideConfig({ TRUST_GEO_HEADER: false }); await ctx.close(); });

  const balance = async (t: string) => BigInt((await ctx.http.get('/api/wallet').set(auth(t))).body.balance);
  const rows = async () => (await ctx.http.get('/api/admin/payments/eligibility').set(auth(admin.token))).body as any[];
  const row = async (method: string, country = 'BR') => (await rows()).find((r) => r.provider === 'paysafe' && r.method === method && r.country === country);
  const approve = (id: string) => ctx.http.patch(`/api/admin/payments/eligibility/${id}`).set(auth(admin.token))
    .send({ athosbetEligible: true, regulatoryApproved: true, gatewayApproved: true, enabled: true, evidence: 'Paysafe sandbox onboarding ticket #TEST-1; legal memo LM-001' });
  const webhook = (event: Record<string, unknown>, signature?: string) => {
    const w = fake.webhook(event);
    return ctx.http.post('/api/payments/webhooks/paysafe').set('content-type', 'application/json').set('signature', signature ?? w.signature).send(w.raw);
  };

  it('Paysafe methods are NOT offered until eligibility, regulation and gateway approval are all recorded', async () => {
    const u = await registerUser(ctx, { country: 'BR' }, BR);
    let methods = (await ctx.http.get('/api/payments/methods').set(auth(u.token)).set(BR)).body;
    expect(methods.find((m: any) => m.method === 'PIX').provider).toBe('sandbox');
    const pix = await row('PIX');
    expect(pix.enabled).toBe(false);
    const partial = await ctx.http.patch(`/api/admin/payments/eligibility/${pix.id}`).set(auth(admin.token)).send({ gatewayApproved: true, enabled: true, evidence: 'x' });
    expect(partial.body.code).toBe('APPROVALS_MISSING');
    const noEvidence = await ctx.http.patch(`/api/admin/payments/eligibility/${(await row('BOLETO')).id}`).set(auth(admin.token)).send({ athosbetEligible: true, regulatoryApproved: true, gatewayApproved: true, enabled: true });
    expect(noEvidence.body.code).toBe('EVIDENCE_REQUIRED');
    // only ADMIN may approve
    const risk = await createStaff(ctx, 'RISK');
    expect((await ctx.http.patch(`/api/admin/payments/eligibility/${pix.id}`).set(auth(risk.token)).send({ enabled: true })).body.code).toBe('INSUFFICIENT_ROLE');
    expect((await approve(pix.id)).status).toBe(200);
    methods = (await ctx.http.get('/api/payments/methods').set(auth(u.token)).set(BR)).body;
    expect(methods.find((m: any) => m.method === 'PIX')).toMatchObject({ provider: 'paysafe', currency: 'BRL', deposit: true });
    // country-specific: a GB player does not get Paysafe PIX
    const gb = await registerUser(ctx, { country: 'GB' });
    const gbm = (await ctx.http.get('/api/payments/methods').set(auth(gb.token)).set('cf-ipcountry', 'GB')).body;
    expect(gbm.find((m: any) => m.method === 'PIX').provider).toBe('sandbox');
    const audit = (await ctx.http.get('/api/admin/audit?action=payments.eligibility.update').set(auth(admin.token))).body;
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('PIX deposit: redirect → webhook → authoritative re-read → credited exactly once', async () => {
    const u = await registerUser(ctx, { country: 'BR' }, BR);
    const start = await balance(u.token);
    const d = await ctx.http.post('/api/payments/deposits').set(auth(u.token)).set(BR).send({ amount: '50.00', method: 'PIX', idempotencyKey: idem() });
    expect(d.status).toBe(201);
    expect(d.body.payment).toMatchObject({ provider: 'paysafe', status: 'REQUIRES_ACTION', providerCurrency: 'BRL' });
    expect(d.body.nextAction.type).toBe('REDIRECT');
    expect(await balance(u.token)).toBe(start);
    const handleId = d.body.payment.providerHandleId;
    // a webhook arriving BEFORE the customer paid does not credit anything (status re-read says INITIATED)
    await webhook({ id: 'evt-early', eventName: 'PAYMENT_HANDLE_INITIATED', payload: { id: handleId, merchantRefNum: `${d.body.payment.id}-h` } }).expect(200);
    expect(await balance(u.token)).toBe(start);
    fake.pay(handleId);
    const evt = { id: 'evt-payable-1', eventName: 'PAYMENT_HANDLE_PAYABLE', payload: { id: handleId, merchantRefNum: `${d.body.payment.id}-h`, amount: 999999 } };
    const results = await Promise.all([1, 2, 3].map(() => webhook(evt)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    // amount in the payload is ignored — the authoritative amount is the one we requested
    expect(await balance(u.token)).toBe(start + 5000n);
    expect(fake.payments.size).toBeGreaterThanOrEqual(1);
    const p = (await ctx.http.get('/api/payments').set(auth(u.token))).body.find((x: any) => x.id === d.body.payment.id);
    expect(p.status).toBe('COMPLETED');
    expect((await ctx.get(LedgerService).reconcile()).ok).toBe(true);
  });

  it('rejects forged webhooks and records them', async () => {
    const r = await webhook({ id: 'evt-forged', eventName: 'PAYMENT_COMPLETED', payload: { merchantRefNum: 'x' } }, 'Zm9yZ2Vk');
    expect(r.status).toBe(401);
    const a = (await ctx.http.get('/api/admin/audit?action=payment.webhook.invalid_signature').set(auth(admin.token))).body;
    expect(a.length).toBeGreaterThanOrEqual(1);
  });

  it('lost webhook: the asynchronous sync job confirms the deposit', async () => {
    const u = await registerUser(ctx, { country: 'BR' }, BR);
    const start = await balance(u.token);
    const d = (await ctx.http.post('/api/payments/deposits').set(auth(u.token)).set(BR).send({ amount: '20.00', method: 'PIX', idempotencyKey: idem() })).body;
    fake.pay(d.payment.providerHandleId);
    await ctx.dbs.pool.query(`UPDATE payments SET created_at = now() - interval '5 minutes', last_synced_at = now() - interval '5 minutes' WHERE id=$1`, [d.payment.id]);
    const s = await ctx.get(PaymentsService).syncPending();
    expect(s.completed).toBeGreaterThanOrEqual(1);
    expect(await balance(u.token)).toBe(start + 2000n);
    // a second run is a no-op
    await ctx.get(PaymentsService).syncPending(0);
    expect(await balance(u.token)).toBe(start + 2000n);
  });

  it('card: tokenisation step, confirmation with the Paysafe.js token, declines never credit', async () => {
    await approve((await row('CREDIT_CARD', 'BR')).id).expect(200);
    const u = await registerUser(ctx, { country: 'BR' }, BR);
    const start = await balance(u.token);
    const d = (await ctx.http.post('/api/payments/deposits').set(auth(u.token)).set(BR).send({ amount: '30.00', method: 'CREDIT_CARD', idempotencyKey: idem() })).body;
    expect(d.nextAction).toMatchObject({ type: 'TOKENIZE_CARD', sdk: { apiKey: 'pk_test', accountId: '1002', amount: 3000, currencyCode: 'BRL', merchantRefNum: d.payment.id } });
    const ok = await ctx.http.post(`/api/payments/${d.payment.id}/confirm`).set(auth(u.token)).send({ paymentToken: 'PHcardtoken123' });
    expect(ok.body.status).toBe('COMPLETED');
    expect(await balance(u.token)).toBe(start + 3000n);
    const again = await ctx.http.post(`/api/payments/${d.payment.id}/confirm`).set(auth(u.token)).send({ paymentToken: 'PHcardtoken123' });
    expect(again.body.code).toBe('PAYMENT_NOT_AWAITING_ACTION');

    fake.declineTokens.add('PHdeclined0001');
    const d2 = (await ctx.http.post('/api/payments/deposits').set(auth(u.token)).set(BR).send({ amount: '30.00', method: 'CREDIT_CARD', idempotencyKey: idem() })).body;
    const no = await ctx.http.post(`/api/payments/${d2.payment.id}/confirm`).set(auth(u.token)).send({ paymentToken: 'PHdeclined0001' });
    expect(no.body.status).toBe('FAILED');
    expect(await balance(u.token)).toBe(start + 3000n);
  });

  it('withdrawal via standalone credit; provider failure reverses the hold', async () => {
    const u = await registerUser(ctx, { country: 'BR' }, BR);
    const start = await balance(u.token);
    const w = await ctx.http.post('/api/payments/withdrawals').set(auth(u.token)).set(BR).send({ amount: '15.00', method: 'PIX', idempotencyKey: idem(), payoutDetails: { pixKey: 'player@example.com' } });
    expect(w.status).toBe(201);
    expect(w.body.payment).toMatchObject({ provider: 'paysafe', status: 'COMPLETED' });
    expect(await balance(u.token)).toBe(start - 1500n);
    const stored = (await ctx.dbs.pool.query(`SELECT metadata FROM payments WHERE id=$1`, [w.body.payment.id])).rows[0].metadata;
    expect(stored.payoutDetails.pixKey).toBe('***.com'); // masked
    expect(stored.payoutEnc).toMatch(/^v1\./); // encrypted for later payouts
    fake.failCredits = true;
    const f = await ctx.http.post('/api/payments/withdrawals').set(auth(u.token)).set(BR).send({ amount: '10.00', method: 'PIX', idempotencyKey: idem(), payoutDetails: { pixKey: 'player@example.com' } });
    expect(f.body.payment.status).toBe('FAILED');
    expect(await balance(u.token)).toBe(start - 1500n);
    fake.failCredits = false;
    expect((await ctx.get(LedgerService).reconcile()).ok).toBe(true);
  });

  it('refunds a Paysafe deposit, never beyond the original amount', async () => {
    const u = await registerUser(ctx, { country: 'BR' }, BR);
    const d = (await ctx.http.post('/api/payments/deposits').set(auth(u.token)).set(BR).send({ amount: '40.00', method: 'PIX', idempotencyKey: idem() })).body;
    fake.pay(d.payment.providerHandleId);
    await webhook({ id: `evt-${d.payment.id}`, eventName: 'PAYMENT_HANDLE_PAYABLE', payload: { id: d.payment.providerHandleId } }).expect(200);
    const before = await balance(u.token);
    const key = idem();
    const r1 = await ctx.http.post(`/api/admin/payments/${d.payment.id}/refund`).set(auth(admin.token)).send({ amount: 2500, reason: 'Customer request', idempotencyKey: key });
    expect(r1.body).toMatchObject({ direction: 'REFUND', status: 'COMPLETED', parentPaymentId: d.payment.id });
    const replay = await ctx.http.post(`/api/admin/payments/${d.payment.id}/refund`).set(auth(admin.token)).send({ amount: 2500, reason: 'Customer request', idempotencyKey: key });
    expect(replay.body.id).toBe(r1.body.id);
    expect(await balance(u.token)).toBe(before - 2500n);
    const tooMuch = await ctx.http.post(`/api/admin/payments/${d.payment.id}/refund`).set(auth(admin.token)).send({ amount: 2000, reason: 'again', idempotencyKey: idem() });
    expect(tooMuch.body.code).toBe('REFUND_EXCEEDS_DEPOSIT');
    expect(fake.refunds.size).toBe(1);
    expect((await ctx.get(LedgerService).reconcile()).ok).toBe(true);
  });

  it('payment reconciliation detects provider/ledger mismatches and flags them', async () => {
    const ok = (await ctx.http.post('/api/admin/payments/reconcile/paysafe').set(auth(admin.token))).body;
    expect(ok.status).toBe('OK');
    expect(ok.checked).toBeGreaterThan(0);
    // provider now reports a completed payment as failed (e.g. reversed at the acquirer)
    const anyPayment = [...fake.payments.values()].find((p) => p.status === 'COMPLETED');
    anyPayment.status = 'FAILED';
    const bad = (await ctx.http.post('/api/admin/payments/reconcile/paysafe').set(auth(admin.token))).body;
    expect(bad.status).toBe('MISMATCH');
    expect(bad.mismatches.some((m: any) => m.kind === 'STATUS')).toBe(true);
    const flags = (await ctx.http.get('/api/admin/suspicious').set(auth(admin.token))).body;
    expect(flags.some((f: any) => f.kind === 'PAYMENT_RECONCILIATION_MISMATCH')).toBe(true);
    anyPayment.status = 'COMPLETED';
  });

  it('revoking an approval disables the method immediately; Nuvei is registered but never routed', async () => {
    const pix = await row('PIX');
    const r = await ctx.http.patch(`/api/admin/payments/eligibility/${pix.id}`).set(auth(admin.token)).send({ regulatoryApproved: false });
    expect(r.body.enabled).toBe(false);
    const providers = (await ctx.http.get('/api/admin/payments/providers').set(auth(admin.token))).body;
    expect(providers).toEqual(expect.arrayContaining([{ name: 'paysafe', mode: 'SANDBOX', configured: true }, { name: 'nuvei', mode: 'SANDBOX', configured: false }]));
    const u = await registerUser(ctx, { country: 'BR' }, BR);
    const d = await ctx.http.post('/api/payments/deposits').set(auth(u.token)).set(BR).send({ amount: '10.00', method: 'PIX', idempotencyKey: idem() });
    expect(d.body.payment.provider).toBe('sandbox');
  });
});
