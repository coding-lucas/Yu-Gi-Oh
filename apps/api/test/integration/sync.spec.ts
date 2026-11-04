import { auth, buildLeague, createStaff, createTestApp, firstOpenMatch, idem, matchMarkets, registerUser, sel, TestCtx } from '../helpers';
import { SyncService } from '../../src/sports/sync.service';
import { PricingService } from '../../src/odds/pricing.service';
import { SettlementService } from '../../src/settlement/settlement.service';
import { JobsService } from '../../src/jobs/jobs.service';

describe('sports data sync: dedup, status changes, failures', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => ctx.close());
  const count = async () => (await ctx.dbs.pool.query('SELECT COUNT(*)::int n FROM matches')).rows[0].n as number;

  it('re-syncing is idempotent and does not duplicate fixtures', async () => {
    const before = await count();
    const s = await ctx.get(SyncService).syncFixtures(new Date(Date.now() - 1000 * 86_400_000), new Date(Date.now() + 10 * 86_400_000));
    expect(s.created).toBe(0);
    expect(await count()).toBe(before);
  });

  it('deduplicates the same fixture arriving with a different provider id', async () => {
    const before = await count();
    const fx = ctx.provider.fixturesBySlug.get('premier-league')!;
    const up = fx.find((f) => f.status === 'SCHEDULED')!;
    fx.push({ ...up, providerId: `${up.providerId}-other-source`, kickoffAt: new Date(up.kickoffAt.getTime() + 15 * 60_000) });
    await ctx.get(SyncService).syncFixtures();
    expect(await count()).toBe(before);
    const ext = await ctx.dbs.pool.query(`SELECT COUNT(*)::int n FROM match_external_ids WHERE external_id LIKE '%other-source'`);
    expect(ext.rows[0].n).toBe(1);
    fx.pop();
  });

  it('API failures are recorded, keep existing data and do not stop other competitions', async () => {
    ctx.provider.failing.add('premier-league');
    const before = await count();
    const s = await ctx.get(SyncService).syncFixtures();
    expect(s.errors[0]).toMatchObject({ competition: 'premier-league', httpStatus: 503 });
    expect(await count()).toBe(before);
    const run = (await ctx.dbs.pool.query(`SELECT status, error, http_status FROM provider_sync_runs ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(['PARTIAL', 'FAILED']).toContain(run.status);
    expect(run.http_status).toBe(503);
    ctx.provider.failing.delete('premier-league');
  });

  it('suspends markets of imminent matches whose data went stale', async () => {
    const m = await firstOpenMatch(ctx);
    await ctx.dbs.pool.query(`UPDATE matches SET kickoff_at = now() + interval '1 hour', last_synced_at = now() - interval '12 hours' WHERE id=$1`, [m.id]);
    await ctx.get(JobsService).run('stale-check');
    const mk = await matchMarkets(ctx, m.id);
    expect(mk.every((x) => x.status !== 'OPEN')).toBe(true);
    expect(mk[0].suspensionReason).toBe('DATA_STALE');
    // fresh data re-opens it on the next pricing cycle
    await ctx.dbs.pool.query(`UPDATE matches SET last_synced_at = now() WHERE id=$1`, [m.id]);
    await ctx.get(PricingService).priceUpcoming([m.id]);
    expect((await matchMarkets(ctx, m.id)).find((x) => x.key === 'MATCH_RESULT').status).toBe('OPEN');
  });

  it('provider-reported postponement suspends markets; a reschedule beyond 48h voids existing bets', async () => {
    const u = await registerUser(ctx);
    const m = await firstOpenMatch(ctx, 1);
    const s = sel(await matchMarkets(ctx, m.id), 'MATCH_RESULT', 'HOME');
    const bet = (await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '10.00', idempotencyKey: idem() })).body;
    const fx = ctx.provider.fixturesBySlug.get('premier-league')!;
    const [ext] = (await ctx.dbs.pool.query(`SELECT external_id FROM match_external_ids WHERE match_id=$1 AND source='fake'`, [m.id])).rows;
    const f = fx.find((x) => x.providerId === ext.external_id)!;
    f.status = 'POSTPONED';
    await ctx.get(SyncService).syncFixtures();
    await ctx.get(PricingService).closeStarted();
    expect((await matchMarkets(ctx, m.id)).find((x) => x.key === 'MATCH_RESULT').status).toBe('SUSPENDED');
    expect((await ctx.http.get(`/api/bets/${bet.id}`).set(auth(u.token))).body.status).toBe('OPEN');
    // rescheduled 5 days later
    f.status = 'SCHEDULED';
    f.kickoffAt = new Date(f.kickoffAt.getTime() + 5 * 86_400_000);
    await ctx.get(SyncService).syncFixtures(new Date(Date.now() - 86_400_000), new Date(Date.now() + 20 * 86_400_000));
    await ctx.get(SettlementService).settlePending();
    const b = (await ctx.http.get(`/api/bets/${bet.id}`).set(auth(u.token))).body;
    expect(b.status).toBe('VOID');
    expect(b.legs[0].voidReason).toBe('RESCHEDULED');
    expect((await ctx.http.get('/api/wallet').set(auth(u.token))).body.balance).toBe('10000');
    // markets re-open for the new date; later result does not touch the voided bet
    await ctx.get(PricingService).priceUpcoming([m.id]);
    expect((await matchMarkets(ctx, m.id)).find((x) => x.key === 'MATCH_RESULT').status).toBe('OPEN');
    const admin = await createStaff(ctx);
    await ctx.http.post(`/api/admin/sandbox/matches/${m.id}/result`).set(auth(admin.token)).send({ status: 'FINISHED', homeGoals: 3, awayGoals: 0 }).expect(200);
    expect((await ctx.http.get(`/api/bets/${bet.id}`).set(auth(u.token))).body.status).toBe('VOID');
  });

  it('provider result corrections bump the result version and trigger re-settlement', async () => {
    const u = await registerUser(ctx);
    const m = await firstOpenMatch(ctx, 2);
    const s = sel(await matchMarkets(ctx, m.id), 'BOTH_TEAMS_TO_SCORE', 'YES');
    const bet = (await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '10.00', idempotencyKey: idem() })).body;
    const [ext] = (await ctx.dbs.pool.query(`SELECT external_id FROM match_external_ids WHERE match_id=$1 AND source='fake'`, [m.id])).rows;
    const f = ctx.provider.fixturesBySlug.get('premier-league')!.find((x) => x.providerId === ext.external_id)!;
    Object.assign(f, { status: 'FINISHED', homeGoals: 1, awayGoals: 1, kickoffAt: new Date(Date.now() - 3 * 3600_000) });
    await ctx.get(SyncService).syncFixtures(new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() + 20 * 86_400_000));
    await ctx.get(SettlementService).settlePending();
    expect((await ctx.http.get(`/api/bets/${bet.id}`).set(auth(u.token))).body.status).toBe('WON');
    Object.assign(f, { homeGoals: 1, awayGoals: 0 });
    await ctx.get(SyncService).syncFixtures(new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() + 20 * 86_400_000));
    await ctx.get(SettlementService).settlePending();
    const b = (await ctx.http.get(`/api/bets/${bet.id}`).set(auth(u.token))).body;
    expect(b.status).toBe('LOST');
    expect(b.settlementVersion).toBe(2);
    const hist = (await ctx.dbs.pool.query(`SELECT version FROM match_result_history WHERE match_id=$1 ORDER BY version`, [m.id])).rows.map((r) => r.version);
    expect(hist).toEqual([1, 2]);
  });

  it('lists matches grouped by competition with times in the user time zone', async () => {
    const r = await ctx.http.get('/api/matches?filter=week&tz=America/Sao_Paulo');
    expect(r.body.tz).toBe('America/Sao_Paulo');
    expect(r.body.groups[0].competition.slug).toBe('premier-league');
    const bad = await ctx.http.get('/api/matches?filter=week&tz=Not/AZone');
    expect(bad.body.tz).toBe('UTC');
    expect((await ctx.http.get('/api/matches?filter=nope')).status).toBe(400);
  });

  it('builds a fresh league for an unrelated seed deterministically', () => {
    expect(buildLeague(5).length).toBe(buildLeague(5).length);
  });
});
