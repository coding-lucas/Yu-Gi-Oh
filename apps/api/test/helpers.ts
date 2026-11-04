import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import request from 'supertest';
import { simulateLeague, rng } from '@athosbet/odds-engine';
import { overrideConfig } from '../src/config';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/athosbet_test';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = TEST_DB;
overrideConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DB, SCHEDULER_ENABLED: false, SANDBOX_STARTING_BALANCE: 10000 });

import { AppModule } from '../src/app.module';
import { migrate } from '../src/db/migrate';
import { SPORTS_PROVIDER } from '../src/sports/sports-provider.factory';
import { CompetitionRef, ProviderError, ProviderFixture, SportsProvider } from '../src/sports/providers/types';
import { AllExceptionsFilter } from '../src/common/exception.filter';
import { DbService } from '../src/db/db.service';
import { encrypt, generateTotpSecret, hashPassword, totp } from '../src/common/crypto';
import { config } from '../src/config';
import { SyncService } from '../src/sports/sync.service';
import { PricingService } from '../src/odds/pricing.service';
import { ComplianceService } from '../src/compliance/compliance.service';
import { SettingsService } from '../src/settings/settings.service';

export class FakeProvider implements SportsProvider {
  readonly name = 'fake';
  fixturesBySlug = new Map<string, ProviderFixture[]>();
  failing = new Set<string>();
  calls = 0;
  async fixtures(c: CompetitionRef, from: Date, to: Date) {
    this.calls++;
    if (this.failing.has(c.slug)) throw new ProviderError('HTTP 503', 503);
    return (this.fixturesBySlug.get(c.slug) ?? []).filter((f) => f.kickoffAt >= from && f.kickoffAt <= to);
  }
  async history(c: CompetitionRef) {
    if (this.failing.has(c.slug)) throw new ProviderError('HTTP 503', 503);
    return (this.fixturesBySlug.get(c.slug) ?? []).filter((f) => f.status === 'FINISHED');
  }
}

export async function resetDb() {
  const c = new Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(TEST_DB, undefined, () => undefined);
}

const TEAMS = ['Arsenal', 'Chelsea', 'Liverpool', 'Everton', 'Fulham', 'Brentford', 'Burnley', 'Leeds', 'Wolves', 'Villa', 'Spurs', 'Brighton'];

/** League with ~2 seasons of history and one upcoming round in 2 days. */
export function buildLeague(seed = 1): ProviderFixture[] {
  const r = rng(seed);
  const truth = TEAMS.map((id) => ({ id, attack: (r() - 0.5) * 0.6, defense: (r() - 0.5) * 0.6 }));
  const start = new Date(Date.now() - 400 * 86_400_000);
  const hist = simulateLeague(truth, { seed, start, rounds: 4, daysBetweenRounds: 2 });
  const fixtures: ProviderFixture[] = hist.map((m, i) => ({
    providerId: `h${i}`, season: 2025, kickoffAt: m.date, status: 'FINISHED', homeGoals: m.homeGoals, awayGoals: m.awayGoals,
    home: { providerId: m.homeId, name: m.homeId }, away: { providerId: m.awayId, name: m.awayId },
  }));
  for (let i = 0; i < TEAMS.length / 2; i++) {
    fixtures.push({
      providerId: `u${i}`, season: 2026, kickoffAt: new Date(Date.now() + 2 * 86_400_000 + i * 3600_000), status: 'SCHEDULED', homeGoals: null, awayGoals: null,
      home: { providerId: TEAMS[i * 2], name: TEAMS[i * 2] }, away: { providerId: TEAMS[i * 2 + 1], name: TEAMS[i * 2 + 1] },
    });
  }
  return fixtures;
}

export interface TestCtx {
  app: INestApplication;
  http: ReturnType<typeof request>;
  provider: FakeProvider;
  dbs: DbService;
  get<T>(cls: new (...a: any[]) => T): T;
  close(): Promise<void>;
}

export async function createTestApp(opts: { league?: boolean } = {}): Promise<TestCtx> {
  await resetDb();
  const provider = new FakeProvider();
  if (opts.league !== false) provider.fixturesBySlug.set('premier-league', buildLeague());
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SPORTS_PROVIDER).useValue(provider).compile();
  const app = mod.createNestApplication({ logger: false, rawBody: true });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  const get = <T>(cls: new (...a: any[]) => T) => app.get(cls);
  await get(ComplianceService).seedJurisdictions();
  await get(SyncService).syncCatalog();
  get(SettingsService).clearCache();
  if (opts.league !== false) {
    await get(SyncService).syncHistory();
    await get(SyncService).syncFixtures(new Date(Date.now() - 1000 * 86_400_000), new Date(Date.now() + 10 * 86_400_000));
    await get(PricingService).priceUpcoming();
  }
  return {
    app, provider, get, dbs: get(DbService),
    http: request(app.getHttpServer()),
    close: async () => { await app.close(); },
  };
}

let userSeq = 0;
export async function registerUser(ctx: TestCtx, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const email = `user${++userSeq}_${Date.now()}@test.dev`;
  const res = await ctx.http.post('/api/auth/register').set(headers).send({
    email, password: 'Password123', displayName: 'Tester', dateOfBirth: '1990-05-05', country: 'GB', locale: 'en', timezone: 'Europe/London', acceptTerms: true, ...extra,
  });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken as string, id: res.body.user.id as string, email, refresh: res.body.refreshToken as string };
}

export async function createStaff(ctx: TestCtx, role: 'ADMIN' | 'RISK' | 'SUPPORT' = 'ADMIN', withMfa = true) {
  const email = `${role.toLowerCase()}${++userSeq}@athosbet.dev`;
  const secret = generateTotpSecret();
  await ctx.dbs.pool.query(
    `INSERT INTO users(email,password_hash,display_name,role,date_of_birth,country,mfa_secret_enc,mfa_enabled) VALUES ($1,$2,'Staff',$3,'1985-01-01','GB',$4,$5)`,
    [email, await hashPassword('AdminPass123'), role, encrypt(secret, config().DATA_ENCRYPTION_KEY), withMfa],
  );
  const res = await ctx.http.post('/api/auth/login').send({ email, password: 'AdminPass123', ...(withMfa ? { totp: totp(secret) } : {}) });
  return { token: res.body.accessToken as string, email, secret, status: res.status };
}

export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

export async function firstOpenMatch(ctx: TestCtx, offset = 0) {
  const res = await ctx.http.get('/api/matches?filter=week&tz=UTC');
  const all = res.body.groups.flatMap((g: any) => g.matches).filter((m: any) => m.mainMarket?.status === 'OPEN');
  return all[offset];
}

export async function matchMarkets(ctx: TestCtx, matchId: string) {
  return (await ctx.http.get(`/api/matches/${matchId}`)).body.markets as any[];
}

export function sel(markets: any[], key: string, selection: string) {
  const m = markets.find((x) => x.key === key);
  const s = m.selections.find((x: any) => x.key === selection);
  return { oddsId: s.oddsId as number, odds: s.odds as number };
}

let keySeq = 0;
export const idem = () => `key-${Date.now()}-${++keySeq}-${Math.random().toString(36).slice(2)}`;
