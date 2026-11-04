import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { auth, createStaff, idem, resetDb, TestCtx } from '../helpers';
import { AppModule } from '../../src/app.module';
import { SPORTS_PROVIDER } from '../../src/sports/sports-provider.factory';
import { DemoProvider } from '../../src/sports/providers/demo.provider';
import { AllExceptionsFilter } from '../../src/common/exception.filter';
import { DbService } from '../../src/db/db.service';
import { SyncService } from '../../src/sports/sync.service';
import { PricingService } from '../../src/odds/pricing.service';
import { ComplianceService } from '../../src/compliance/compliance.service';
import { LedgerService } from '../../src/ledger/ledger.service';

/**
 * MVP acceptance: a demo user signs up, picks a language, sees Brasileirão and other leagues, reads
 * computed odds, bets with sandbox balance, follows the official result and is settled automatically;
 * the administrator can see and audit the whole operation.
 */
describe('MVP end-to-end (demo provider, HTTP only)', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    await resetDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SPORTS_PROVIDER).useValue(new DemoProvider(true)).compile();
    const app = mod.createNestApplication({ logger: false, rawBody: true });
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.get(ComplianceService).seedJurisdictions();
    const sync = app.get(SyncService);
    await sync.syncCatalog();
    await app.get(DbService).pool.query(`UPDATE competitions SET enabled = slug IN ('brasileirao-serie-a','premier-league')`);
    await sync.syncHistory();
    await sync.syncFixtures();
    await app.get(PricingService).priceUpcoming();
    ctx = { app, http: request(app.getHttpServer()), provider: null as any, dbs: app.get(DbService), get: (c: any) => app.get(c), close: () => app.close() };
  }, 180_000);
  afterAll(async () => ctx?.close());

  it('runs the complete player and operator journey', async () => {
    // 1. sign up in Portuguese
    const reg = await ctx.http.post('/api/auth/register').send({ email: `demo${Date.now()}@athosbet.dev`, password: 'DemoPass2026', displayName: 'Torcedor', dateOfBirth: '1992-03-10', country: 'BR', locale: 'pt', timezone: 'America/Sao_Paulo', acceptTerms: true });
    expect(reg.status).toBe(201);
    expect(reg.body.user.locale).toBe('pt');
    const t = reg.body.accessToken;
    expect((await ctx.http.get('/api/wallet').set(auth(t))).body).toMatchObject({ currency: 'ATH', mode: 'SANDBOX', realMoney: false });

    // 2. Brasileirão is listed first, other leagues too
    const week = (await ctx.http.get('/api/matches?filter=week&tz=America/Sao_Paulo')).body;
    const slugs = week.groups.map((g: any) => g.competition.slug);
    expect(slugs[0]).toBe('brasileirao-serie-a');
    expect(slugs).toContain('premier-league');
    expect((await ctx.http.get('/api/meta')).body.synthetic).toBe(true);

    // 3. computed odds
    const match = week.groups[0].matches.find((m: any) => m.mainMarket?.status === 'OPEN' && new Date(m.kickoffAt) > new Date());
    expect(match).toBeDefined();
    const detail = (await ctx.http.get(`/api/matches/${match.id}`)).body;
    expect(detail.model.version).toMatch(/^dc-poisson/);
    expect(detail.model.lambdaHome).toBeGreaterThan(0.2);
    const home = detail.markets.find((m: any) => m.key === 'MATCH_RESULT').selections.find((s: any) => s.key === 'HOME');

    // 4. bet with sandbox balance
    const bet = await ctx.http.post('/api/bets').set(auth(t)).send({ legs: [{ oddsId: home.oddsId, odds: home.odds }], stake: '25.00', idempotencyKey: idem() });
    expect(bet.status).toBe(201);

    // 5. official result arrives (sandbox operator entry goes through the same ingestion/settlement path)
    const admin = await createStaff(ctx, 'ADMIN');
    await ctx.http.post(`/api/admin/sandbox/matches/${match.id}/result`).set(auth(admin.token)).send({ status: 'FINISHED', homeGoals: 2, awayGoals: 1 }).expect(200);

    // 6. automatic settlement
    const settled = (await ctx.http.get(`/api/bets/${bet.body.id}`).set(auth(t))).body;
    expect(settled.status).toBe('WON');
    const expected = BigInt(Math.floor(2500 * home.odds));
    expect(BigInt(settled.payout)).toBe(expected);
    const bal = BigInt((await ctx.http.get('/api/wallet').set(auth(t))).body.balance);
    expect(bal).toBe(10000n - 2500n + expected);
    const statement = (await ctx.http.get('/api/wallet/statement').set(auth(t))).body;
    expect(statement.map((s: any) => s.type)).toEqual(expect.arrayContaining(['ADJUSTMENT', 'BET_PLACE', 'BET_SETTLE']));

    // 7. admin sees and audits the operation
    const dash = (await ctx.http.get('/api/admin/dashboard').set(auth(admin.token))).body;
    expect(dash.kpis.bets.settled).toBeGreaterThanOrEqual(1);
    expect(BigInt(dash.kpis.money.payouts)).toBe(expected);
    const audit = (await ctx.http.get(`/api/admin/audit?entityType=match&entityId=${match.id}`).set(auth(admin.token))).body;
    expect(audit[0].action).toBe('admin.sandbox.result');
    const bd = (await ctx.http.get(`/api/admin/bets/${bet.body.id}`).set(auth(admin.token))).body;
    expect(bd.ledger.map((l: any) => l.type)).toEqual(['BET_PLACE', 'BET_SETTLE']);
    expect((await ctx.http.get('/api/admin/ledger/reconcile').set(auth(admin.token))).body.ok).toBe(true);
    expect((await ctx.get(LedgerService).reconcile()).ok).toBe(true);

    // 8. model validation from the admin panel
    const bt = (await ctx.http.post('/api/admin/models/backtest').set(auth(admin.token))).body;
    expect(bt.n).toBeGreaterThan(100);
    expect(bt.model.brier).toBeLessThan(bt.baseline.brier);
  }, 120_000);
});
