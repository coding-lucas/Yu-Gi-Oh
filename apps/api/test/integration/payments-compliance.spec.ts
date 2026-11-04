import { overrideConfig } from '../../src/config';
import { auth, createStaff, createTestApp, firstOpenMatch, idem, matchMarkets, registerUser, sel, TestCtx } from '../helpers';
import { LedgerService } from '../../src/ledger/ledger.service';
import { PaymentsService } from '../../src/payments/payments.service';

describe('payments, responsible gambling & territorial rules', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { overrideConfig({ TRUST_GEO_HEADER: false }); await ctx.close(); });
  const balance = async (t: string) => BigInt((await ctx.http.get('/api/wallet').set(auth(t))).body.balance);

  it('card deposits complete synchronously; declined cards fail without credit', async () => {
    const u = await registerUser(ctx);
    const ok = await ctx.http.post('/api/payments/deposits').set(auth(u.token)).send({ amount: '50.00', method: 'CREDIT_CARD', idempotencyKey: idem(), card: { number: '4242 4242 4242 4242' } });
    expect(ok.status).toBe(201);
    expect(ok.body.payment.status).toBe('COMPLETED');
    const bad = await ctx.http.post('/api/payments/deposits').set(auth(u.token)).send({ amount: '50.00', method: 'DEBIT_CARD', idempotencyKey: idem(), card: { number: '4000 0000 0000 0002' } });
    expect(bad.body.payment.status).toBe('FAILED');
    expect(await balance(u.token)).toBe(15000n);
  });

  it('duplicate deposit requests and duplicate webhooks credit exactly once', async () => {
    const u = await registerUser(ctx);
    const key = idem();
    const reqs = await Promise.all([1, 2, 3].map(() => ctx.http.post('/api/payments/deposits').set(auth(u.token)).send({ amount: '20.00', method: 'PIX', idempotencyKey: key })));
    const ids = new Set(reqs.filter((r) => r.status === 201).map((r) => r.body.payment.id));
    expect(ids.size).toBe(1);
    const pid = [...ids][0] as string;
    expect(reqs.find((r) => r.status === 201)!.body.payment.status).toBe('PENDING');
    // PSP delivers the same webhook several times, concurrently
    const svc = ctx.get(PaymentsService);
    const [p] = (await ctx.dbs.pool.query('SELECT provider_ref FROM payments WHERE id=$1', [pid])).rows;
    const body = JSON.stringify({ id: 'evt_dup_1', type: 'payment.succeeded', providerRef: p.provider_ref });
    const sig = svc.sandbox.sign(body);
    const hooks = await Promise.all([1, 2, 3].map(() => ctx.http.post('/api/payments/webhooks/sandbox').set('content-type', 'application/json').set('x-sandbox-signature', sig).send(body)));
    expect(hooks.every((h) => h.status === 200)).toBe(true);
    expect(hooks.filter((h) => h.body.duplicate === false)).toHaveLength(1);
    // a different event id for the same payment still cannot double-credit (ledger idempotency)
    const body2 = JSON.stringify({ id: 'evt_dup_2', type: 'payment.succeeded', providerRef: p.provider_ref });
    await ctx.http.post('/api/payments/webhooks/sandbox').set('content-type', 'application/json').set('x-sandbox-signature', svc.sandbox.sign(body2)).send(body2);
    expect(await balance(u.token)).toBe(12000n);
    // forged signature rejected
    const forged = await ctx.http.post('/api/payments/webhooks/sandbox').set('content-type', 'application/json').set('x-sandbox-signature', 'deadbeef').send(body2);
    expect(forged.status).toBe(401);
    expect((await ctx.get(LedgerService).reconcile()).ok).toBe(true);
  });

  it('withdrawals cannot double-spend under concurrency; large ones require review', async () => {
    const u = await registerUser(ctx); // 100.00
    const rs = await Promise.all(Array.from({ length: 5 }, () => ctx.http.post('/api/payments/withdrawals').set(auth(u.token)).send({ amount: '40.00', method: 'BANK_TRANSFER', idempotencyKey: idem() })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
    expect(await balance(u.token)).toBe(2000n);
    const dup = idem();
    const a = await ctx.http.post('/api/payments/withdrawals').set(auth(u.token)).send({ amount: '10.00', method: 'PIX', idempotencyKey: dup });
    const b = await ctx.http.post('/api/payments/withdrawals').set(auth(u.token)).send({ amount: '10.00', method: 'PIX', idempotencyKey: dup });
    expect(a.body.payment.id).toBe(b.body.payment.id);
    expect(await balance(u.token)).toBe(1000n);

    const rich = await registerUser(ctx);
    await ctx.dbs.pool.query(`INSERT INTO settings(key,value) VALUES ('risk','{"largeWithdrawalReview":5000}') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
    (ctx.get(PaymentsService) as any).settings.clearCache();
    await ctx.http.post('/api/payments/deposits').set(auth(rich.token)).send({ amount: '50.00', method: 'CREDIT_CARD', idempotencyKey: idem() }).expect(201);
    const big = await ctx.http.post('/api/payments/withdrawals').set(auth(rich.token)).send({ amount: '60.00', method: 'BANK_TRANSFER', idempotencyKey: idem() });
    expect(big.body.payment.status).toBe('REQUIRES_REVIEW');
    expect(await balance(rich.token)).toBe(9000n);
    const admin = await createStaff(ctx, 'RISK');
    const rej = await ctx.http.post(`/api/admin/payments/${big.body.payment.id}/reject`).set(auth(admin.token)).send({ reason: 'AML review' });
    expect(rej.status).toBe(200);
    expect(await balance(rich.token)).toBe(15000n);
    const flags = (await ctx.http.get('/api/admin/suspicious').set(auth(admin.token))).body;
    expect(flags.some((f: any) => f.kind === 'LOW_TURNOVER_WITHDRAWAL')).toBe(true);
    await ctx.dbs.pool.query(`DELETE FROM settings WHERE key='risk'`);
    (ctx.get(PaymentsService) as any).settings.clearCache();
    expect((await ctx.get(LedgerService).reconcile()).ok).toBe(true);
  });

  it('enforces deposit limits; increases only apply after the cooling-off period', async () => {
    const u = await registerUser(ctx);
    await ctx.http.patch('/api/account/limits').set(auth(u.token)).send({ depositDaily: '30.00' }).expect(200);
    await ctx.http.post('/api/payments/deposits').set(auth(u.token)).send({ amount: '25.00', method: 'CREDIT_CARD', idempotencyKey: idem() }).expect(201);
    const over = await ctx.http.post('/api/payments/deposits').set(auth(u.token)).send({ amount: '10.00', method: 'CREDIT_CARD', idempotencyKey: idem() });
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('DEPOSIT_LIMIT_EXCEEDED');
    const raised = (await ctx.http.patch('/api/account/limits').set(auth(u.token)).send({ depositDaily: '500.00' })).body;
    expect(raised.depositDaily).toBe('3000'); // unchanged for now
    expect(raised.pending.depositDaily).toBe('50000');
    const lowered = (await ctx.http.patch('/api/account/limits').set(auth(u.token)).send({ depositDaily: '26.00' })).body;
    expect(lowered.depositDaily).toBe('2600'); // decreases are immediate
  });

  it('enforces loss limits and self-exclusion on betting', async () => {
    const u = await registerUser(ctx);
    const m = await firstOpenMatch(ctx);
    const s = sel(await matchMarkets(ctx, m.id), 'MATCH_RESULT', 'HOME');
    await ctx.http.patch('/api/account/limits').set(auth(u.token)).send({ lossDaily: '15.00' }).expect(200);
    await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '10.00', idempotencyKey: idem() }).expect(201);
    const r = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '10.00', idempotencyKey: idem() });
    expect(r.body.code).toBe('LOSS_LIMIT_EXCEEDED');
    const ex = await ctx.http.post('/api/account/exclusion').set(auth(u.token)).send({ kind: 'COOL_OFF', days: 7 });
    expect(ex.status).toBe(201);
    const blocked = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '1.00', idempotencyKey: idem() });
    expect(blocked.body.code).toBe('SELF_EXCLUDED');
    const dep = await ctx.http.post('/api/payments/deposits').set(auth(u.token)).send({ amount: '5.00', method: 'CREDIT_CARD', idempotencyKey: idem() });
    expect(dep.body.code).toBe('SELF_EXCLUDED');
    // withdrawing existing funds remains possible
    await ctx.http.post('/api/payments/withdrawals').set(auth(u.token)).send({ amount: '5.00', method: 'PIX', idempotencyKey: idem() }).expect(201);
  });

  it('applies territorial restrictions from trusted geo signals — never from the language', async () => {
    overrideConfig({ TRUST_GEO_HEADER: true });
    const u = await registerUser(ctx, { locale: 'pt' });
    const m = await firstOpenMatch(ctx);
    const s = sel(await matchMarkets(ctx, m.id), 'MATCH_RESULT', 'HOME');
    const fromUS = await ctx.http.post('/api/bets').set(auth(u.token)).set('cf-ipcountry', 'US').send({ legs: [s], stake: '1.00', idempotencyKey: idem() });
    expect(fromUS.status).toBe(403);
    expect(fromUS.body.code).toBe('JURISDICTION_BLOCKED');
    // switching language does not lift the block
    await ctx.http.patch('/api/account/profile').set(auth(u.token)).send({ locale: 'en' }).expect(200);
    const again = await ctx.http.post('/api/bets').set(auth(u.token)).set('cf-ipcountry', 'US').set('accept-language', 'pt-BR').send({ legs: [s], stake: '1.00', idempotencyKey: idem() });
    expect(again.body.code).toBe('JURISDICTION_BLOCKED');
    // Brazil: sandbox allowed, real money not available
    const fromBR = await ctx.http.post('/api/bets').set(auth(u.token)).set('cf-ipcountry', 'BR').send({ legs: [s], stake: '1.00', idempotencyKey: idem() });
    expect(fromBR.status).toBe(201);
    const j = (await ctx.http.get('/api/account/jurisdiction').set(auth(u.token)).set('cf-ipcountry', 'BR')).body;
    expect(j.request).toBe('SANDBOX_ONLY');
    expect(j.realMoneyAvailable).toBe(false);
    const methods = (await ctx.http.get('/api/payments/methods').set(auth(u.token)).set('cf-ipcountry', 'BR')).body;
    expect(methods.every((m: any) => m.real === false)).toBe(true);
    // registration from a blocked territory / blocked account country
    const reg = await ctx.http.post('/api/auth/register').set('cf-ipcountry', 'US').send({ email: `x${Date.now()}@t.dev`, password: 'Password123', displayName: 'Xx', dateOfBirth: '1990-01-01', country: 'GB', acceptTerms: true });
    expect(reg.body.code).toBe('JURISDICTION_BLOCKED');
    overrideConfig({ TRUST_GEO_HEADER: false });
    const regFR = await ctx.http.post('/api/auth/register').send({ email: `y${Date.now()}@t.dev`, password: 'Password123', displayName: 'Yy', dateOfBirth: '1990-01-01', country: 'FR', acceptTerms: true });
    expect(regFR.body.code).toBe('JURISDICTION_BLOCKED');
  });

  it('rejects under-age registration', async () => {
    const r = await ctx.http.post('/api/auth/register').send({ email: `kid${Date.now()}@t.dev`, password: 'Password123', displayName: 'Kid', dateOfBirth: `${new Date().getFullYear() - 17}-01-01`, country: 'GB', acceptTerms: true });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('UNDERAGE');
  });
});
