import { auth, createStaff, createTestApp, registerUser, TestCtx } from '../helpers';
import { totp } from '../../src/common/crypto';

describe('authentication & authorisation security', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await createTestApp({ league: false }); });
  afterAll(async () => ctx.close());

  it('requires authentication for private routes', async () => {
    expect((await ctx.http.get('/api/wallet')).status).toBe(401);
    expect((await ctx.http.get('/api/wallet').set(auth('garbage'))).status).toBe(401);
  });

  it('denies admin routes to players and to staff without MFA', async () => {
    const u = await registerUser(ctx);
    const r = await ctx.http.get('/api/admin/dashboard').set(auth(u.token));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('INSUFFICIENT_ROLE');
    const noMfa = await createStaff(ctx, 'ADMIN', false);
    const r2 = await ctx.http.get('/api/admin/dashboard').set(auth(noMfa.token));
    expect(r2.body.code).toBe('MFA_REQUIRED');
    const ok = await createStaff(ctx, 'ADMIN', true);
    expect((await ctx.http.get('/api/admin/dashboard').set(auth(ok.token))).status).toBe(200);
    const support = await createStaff(ctx, 'SUPPORT', true);
    const r3 = await ctx.http.patch('/api/admin/settings/risk').set(auth(support.token)).send({ maxStake: 1 });
    expect(r3.body.code).toBe('INSUFFICIENT_ROLE');
  });

  it('requires a TOTP code for staff with MFA and rejects wrong codes', async () => {
    const s = await createStaff(ctx, 'RISK', true);
    expect((await ctx.http.post('/api/auth/login').send({ email: s.email, password: 'AdminPass123' })).body.code).toBe('MFA_CODE_REQUIRED');
    expect((await ctx.http.post('/api/auth/login').send({ email: s.email, password: 'AdminPass123', totp: '000000' })).body.code).toBe('INVALID_MFA_CODE');
    expect((await ctx.http.post('/api/auth/login').send({ email: s.email, password: 'AdminPass123', totp: totp(s.secret) })).status).toBe(200);
  });

  it('MFA enrolment flow issues an MFA session', async () => {
    const u = await registerUser(ctx);
    const setup = await ctx.http.post('/api/auth/mfa/setup').set(auth(u.token));
    expect(setup.body.otpauthUrl).toContain('otpauth://totp/AthosBet');
    const en = await ctx.http.post('/api/auth/mfa/enable').set(auth(u.token)).send({ code: totp(setup.body.secret) });
    expect(en.status).toBe(201);
    expect((await ctx.http.get('/api/auth/me').set(auth(en.body.accessToken))).body.sessionMfa).toBe(true);
  });

  it('enforces CSRF header for cookie-authenticated mutations', async () => {
    const u = await registerUser(ctx);
    const login = await ctx.http.post('/api/auth/login').send({ email: u.email, password: 'Password123' });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const at = cookies.find((c) => c.startsWith('ab_at='))!.split(';')[0];
    expect(cookies.find((c) => c.startsWith('ab_at='))).toMatch(/HttpOnly/);
    const noHeader = await ctx.http.patch('/api/account/profile').set('Cookie', at).send({ locale: 'de' });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.code).toBe('CSRF_HEADER_MISSING');
    const ok = await ctx.http.patch('/api/account/profile').set('Cookie', at).set('x-athos-csrf', '1').send({ locale: 'de' });
    expect(ok.status).toBe(200);
    expect((await ctx.http.get('/api/auth/me').set('Cookie', at)).status).toBe(200);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const u = await registerUser(ctx);
    const r1 = await ctx.http.post('/api/auth/refresh').send({ refreshToken: u.refresh });
    expect(r1.status).toBe(200);
    const replay = await ctx.http.post('/api/auth/refresh').send({ refreshToken: u.refresh });
    expect(replay.body.code).toBe('REFRESH_REUSED');
    const r2 = await ctx.http.post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401); // whole family revoked
  });

  it('locks the account after repeated failed logins and flags it', async () => {
    const u = await registerUser(ctx);
    for (let i = 0; i < 5; i++) await ctx.http.post('/api/auth/login').send({ email: u.email, password: 'WrongPass123' });
    const r = await ctx.http.post('/api/auth/login').send({ email: u.email, password: 'Password123' });
    expect(r.body.code).toBe('ACCOUNT_LOCKED');
    const flags = await ctx.dbs.pool.query(`SELECT kind FROM suspicious_activities WHERE user_id=$1`, [u.id]);
    expect(flags.rows.map((x) => x.kind)).toContain('BRUTE_FORCE_LOCKOUT');
  });

  it('password reset is single-use and revokes sessions; no account enumeration', async () => {
    const u = await registerUser(ctx);
    const unknown = await ctx.http.post('/api/auth/password/forgot').send({ email: 'nobody@nowhere.dev' });
    expect(unknown.body).toEqual({ ok: true });
    const f = await ctx.http.post('/api/auth/password/forgot').send({ email: u.email });
    const tok = f.body.devToken;
    expect((await ctx.http.post('/api/auth/password/reset').send({ token: tok, password: 'NewPassword456' })).status).toBe(200);
    expect((await ctx.http.post('/api/auth/password/reset').send({ token: tok, password: 'NewPassword789' })).body.code).toBe('INVALID_RESET_TOKEN');
    expect((await ctx.http.post('/api/auth/refresh').send({ refreshToken: u.refresh })).status).toBe(401);
    expect((await ctx.http.post('/api/auth/login').send({ email: u.email, password: 'NewPassword456' })).status).toBe(200);
  });

  it('validates input strictly and never leaks internals', async () => {
    const weak = await ctx.http.post('/api/auth/register').send({ email: 'a@b.dev', password: 'short', displayName: 'A', dateOfBirth: '1990-01-01', country: 'GB', acceptTerms: true });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('VALIDATION_FAILED');
    const sqli = await ctx.http.get(`/api/matches?filter=week&competition=${encodeURIComponent("x' OR 1=1 --")}`);
    expect(sqli.status).toBe(200);
    expect(sqli.body.total).toBe(0);
    expect((await ctx.http.get('/api/matches/not-a-uuid')).status).toBe(400);
  });

  it('records an audit trail for sensitive admin actions', async () => {
    const a = await createStaff(ctx, 'ADMIN');
    await ctx.http.patch('/api/admin/settings/risk').set(auth(a.token)).send({ maxStake: 400000 }).expect(200);
    const logs = (await ctx.http.get('/api/admin/audit?action=settings.risk.update').set(auth(a.token))).body;
    expect(logs[0].after.maxStake).toBe(400000);
    expect(logs[0].before.maxStake).toBe(500000);
  });
});
