import { auth, createStaff, createTestApp, firstOpenMatch, idem, matchMarkets, registerUser, sel, TestCtx } from '../helpers';
import { LedgerService } from '../../src/ledger/ledger.service';
import { PricingService } from '../../src/odds/pricing.service';
import { SettlementService } from '../../src/settlement/settlement.service';

describe('betting, wallet & settlement (integration, real PostgreSQL)', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => ctx.close());

  const balance = async (token: string) => BigInt((await ctx.http.get('/api/wallet').set(auth(token))).body.balance);
  const reconcileOk = async () => {
    const r = await ctx.get(LedgerService).reconcile();
    expect(r.accountMismatches).toEqual([]);
    expect(r.unbalancedTransactions).toEqual([]);
    expect(r.ok).toBe(true);
  };

  it('publishes priced markets for upcoming matches', async () => {
    const m = await firstOpenMatch(ctx);
    expect(m).toBeDefined();
    const mk = await matchMarkets(ctx, m.id);
    const keys = mk.map((x) => x.key);
    for (const k of ['MATCH_RESULT', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'BOTH_TEAMS_TO_SCORE', 'TOTAL_GOALS@2.5', 'CORRECT_SCORE']) expect(keys).toContain(k);
    const mr = mk.find((x) => x.key === 'MATCH_RESULT');
    const over = mr.selections.reduce((s: number, x: any) => s + 1 / x.odds, 0) - 1;
    expect(over).toBeGreaterThan(0.04);
  });

  it('places a single bet atomically and debits the stake', async () => {
    const u = await registerUser(ctx);
    expect(await balance(u.token)).toBe(10000n);
    const m = await firstOpenMatch(ctx);
    const s = sel(await matchMarkets(ctx, m.id), 'MATCH_RESULT', 'HOME');
    const res = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '10.00', idempotencyKey: idem() });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(BigInt(res.body.potentialPayout)).toBe(BigInt(Math.floor(1000 * s.odds)));
    expect(await balance(u.token)).toBe(9000n);
    await reconcileOk();
  });

  it('is idempotent on retried submissions', async () => {
    const u = await registerUser(ctx);
    const m = await firstOpenMatch(ctx);
    const s = sel(await matchMarkets(ctx, m.id), 'MATCH_RESULT', 'DRAW');
    const key = idem();
    const [a, b] = await Promise.all([1, 2].map(() => ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '5.00', idempotencyKey: key })));
    expect(a.body.id).toBe(b.body.id);
    expect(await balance(u.token)).toBe(9500n);
    const reuse = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '6.00', idempotencyKey: key });
    expect(reuse.status).toBe(409);
    expect(reuse.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('never overspends under concurrent bet requests', async () => {
    const u = await registerUser(ctx); // 100.00
    const m = await firstOpenMatch(ctx);
    const s = sel(await matchMarkets(ctx, m.id), 'BOTH_TEAMS_TO_SCORE', 'YES');
    const results = await Promise.all(Array.from({ length: 16 }, () => ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '15.00', idempotencyKey: idem() })));
    const ok = results.filter((r) => r.status === 201).length;
    expect(ok).toBe(6); // 6 × 15 = 90 ≤ 100 < 105
    expect(results.filter((r) => r.status === 422).every((r) => r.body.code === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await balance(u.token)).toBe(1000n);
    await reconcileOk();
  });

  it('rejects bets when odds changed, unless the player accepts the change', async () => {
    const u = await registerUser(ctx);
    const m = await firstOpenMatch(ctx);
    const s = sel(await matchMarkets(ctx, m.id), 'MATCH_RESULT', 'AWAY');
    // move the price: re-publish with a bigger margin
    await ctx.dbs.pool.query(`INSERT INTO settings(key,value) VALUES ('pricing','{"margins":{"MATCH_RESULT":0.12}}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    (ctx.get(PricingService) as any).settings.clearCache();
    await ctx.get(PricingService).priceUpcoming([m.id]);
    const shorter = sel(await matchMarkets(ctx, m.id), 'MATCH_RESULT', 'AWAY');
    expect(shorter.odds).toBeLessThan(s.odds);

    const rej = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '2.00', idempotencyKey: idem() });
    expect(rej.status).toBe(409);
    expect(rej.body.code).toBe('ODDS_CHANGED');
    expect(rej.body.details.changes[0].currentK).toBe(Math.round(shorter.odds * 1000));
    const higherOnly = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '2.00', idempotencyKey: idem(), oddsPolicy: 'HIGHER' });
    expect(higherOnly.status).toBe(409);
    const any = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [s], stake: '2.00', idempotencyKey: idem(), oddsPolicy: 'ANY' });
    expect(any.status).toBe(201);
    expect(any.body.legs[0].odds).toBe(shorter.odds);
    await ctx.dbs.pool.query(`DELETE FROM settings WHERE key='pricing'`);
    (ctx.get(PricingService) as any).settings.clearCache();
    await ctx.get(PricingService).priceUpcoming();
    // price history is kept (versioned odds)
    const hist = await ctx.http.get(`/api/markets/${(await matchMarkets(ctx, m.id)).find((x) => x.key === 'MATCH_RESULT').id}/history`);
    expect(hist.body.filter((h: any) => h.selection === 'AWAY').length).toBeGreaterThanOrEqual(2);
  });

  it('rejects multiples with two legs from the same match and invalid stakes', async () => {
    const u = await registerUser(ctx);
    const m = await firstOpenMatch(ctx);
    const mk = await matchMarkets(ctx, m.id);
    const r = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [sel(mk, 'MATCH_RESULT', 'HOME'), sel(mk, 'TOTAL_GOALS@2.5', 'OVER')], stake: '1.00', idempotencyKey: idem() });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('INVALID_SLIP');
    expect(r.body.details[0].code).toBe('SAME_MATCH_IN_MULTIPLE');
    const small = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [sel(mk, 'MATCH_RESULT', 'HOME')], stake: '0.10', idempotencyKey: idem() });
    expect(small.body.code).toBe('STAKE_BELOW_MINIMUM');
  });

  it('blocks closed markets (kick-off passed) and suspended markets', async () => {
    const u = await registerUser(ctx);
    const admin = await createStaff(ctx);
    const m = await firstOpenMatch(ctx, 5);
    const mk = await matchMarkets(ctx, m.id);
    const btts = mk.find((x) => x.key === 'BOTH_TEAMS_TO_SCORE');
    const sus = await ctx.http.post(`/api/admin/markets/${btts.id}/suspend`).set(auth(admin.token)).send({ suspended: true, reason: 'TEST' });
    expect(sus.status).toBe(200);
    const r1 = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [sel(mk, 'BOTH_TEAMS_TO_SCORE', 'YES')], stake: '1.00', idempotencyKey: idem() });
    expect(r1.body.code).toBe('MARKET_NOT_OPEN');
    // manual suspension survives re-pricing
    await ctx.get(PricingService).priceUpcoming([m.id]);
    expect((await matchMarkets(ctx, m.id)).find((x) => x.key === 'BOTH_TEAMS_TO_SCORE').status).toBe('SUSPENDED');
    await ctx.dbs.pool.query(`UPDATE matches SET kickoff_at = now() - interval '1 minute', original_kickoff_at = now() - interval '1 minute' WHERE id = $1`, [m.id]);
    const r2 = await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [sel(mk, 'MATCH_RESULT', 'HOME')], stake: '1.00', idempotencyKey: idem() });
    expect(['MATCH_NOT_OPEN', 'MARKET_NOT_OPEN']).toContain(r2.body.code);
    await ctx.get(PricingService).closeStarted();
    expect((await matchMarkets(ctx, m.id)).every((x) => x.status === 'CLOSED')).toBe(true);
  });

  it('settles automatically on the official result — exactly once', async () => {
    const u = await registerUser(ctx);
    const admin = await createStaff(ctx);
    const m = await firstOpenMatch(ctx, 1);
    const mk = await matchMarkets(ctx, m.id);
    const home = sel(mk, 'MATCH_RESULT', 'HOME');
    const over = sel(mk, 'TOTAL_GOALS@2.5', 'OVER');
    const b1 = (await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [home], stake: '10.00', idempotencyKey: idem() })).body;
    const b2 = (await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [over], stake: '10.00', idempotencyKey: idem() })).body;
    expect(await balance(u.token)).toBe(8000n);

    const res = await ctx.http.post(`/api/admin/sandbox/matches/${m.id}/result`).set(auth(admin.token)).send({ status: 'FINISHED', homeGoals: 2, awayGoals: 0 });
    expect(res.status).toBe(200);
    // run settlement again (duplicate events / concurrent workers) — must be a no-op
    await Promise.all([ctx.get(SettlementService).settleMatch(m.id), ctx.get(SettlementService).settleMatch(m.id), ctx.get(SettlementService).settlePending()]);

    const s1 = (await ctx.http.get(`/api/bets/${b1.id}`).set(auth(u.token))).body;
    const s2 = (await ctx.http.get(`/api/bets/${b2.id}`).set(auth(u.token))).body;
    expect(s1.status).toBe('WON');
    expect(s2.status).toBe('LOST');
    const payout = BigInt(Math.floor(1000 * home.odds));
    expect(BigInt(s1.payout)).toBe(payout);
    expect(await balance(u.token)).toBe(8000n + payout);
    const n = await ctx.dbs.pool.query(`SELECT COUNT(*)::int n FROM settlements WHERE bet_id = ANY($1)`, [[b1.id, b2.id]]);
    expect(n.rows[0].n).toBe(2);
    await reconcileOk();
  });

  it('re-settles bets when the official result is corrected (with reversing entries)', async () => {
    const u = await registerUser(ctx);
    const admin = await createStaff(ctx);
    const m = await firstOpenMatch(ctx, 2);
    const mk = await matchMarkets(ctx, m.id);
    const draw = sel(mk, 'MATCH_RESULT', 'DRAW');
    const bet = (await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [draw], stake: '10.00', idempotencyKey: idem() })).body;
    await ctx.http.post(`/api/admin/sandbox/matches/${m.id}/result`).set(auth(admin.token)).send({ status: 'FINISHED', homeGoals: 1, awayGoals: 1 });
    const won = BigInt(Math.floor(1000 * draw.odds));
    expect(await balance(u.token)).toBe(9000n + won);
    // correction 1-1 → 2-1: the draw bet now loses
    await ctx.http.post(`/api/admin/sandbox/matches/${m.id}/result`).set(auth(admin.token)).send({ status: 'FINISHED', homeGoals: 2, awayGoals: 1 });
    const after = (await ctx.http.get(`/api/bets/${bet.id}`).set(auth(u.token))).body;
    expect(after.status).toBe('LOST');
    expect(after.settlementVersion).toBe(2);
    expect(await balance(u.token)).toBe(9000n);
    // correcting back restores the win, version 3
    await ctx.http.post(`/api/admin/sandbox/matches/${m.id}/result`).set(auth(admin.token)).send({ status: 'FINISHED', homeGoals: 0, awayGoals: 0 });
    const again = (await ctx.http.get(`/api/bets/${bet.id}`).set(auth(u.token))).body;
    expect(again.status).toBe('WON');
    expect(again.settlementVersion).toBe(3);
    expect(await balance(u.token)).toBe(9000n + won);
    const detail = (await ctx.http.get(`/api/admin/bets/${bet.id}`).set(auth(admin.token))).body;
    expect(detail.settlements).toHaveLength(3);
    expect(detail.ledger.filter((t: any) => t.type === 'BET_RESETTLE_REVERSAL')).toHaveLength(2);
    await reconcileOk();
  });

  it('voids bets on cancelled matches and returns stakes; multiples drop the void leg', async () => {
    const u = await registerUser(ctx);
    const admin = await createStaff(ctx);
    const a = await firstOpenMatch(ctx, 0);
    const b = await firstOpenMatch(ctx, 1);
    const sa = sel(await matchMarkets(ctx, a.id), 'MATCH_RESULT', 'HOME');
    const sb = sel(await matchMarkets(ctx, b.id), 'MATCH_RESULT', 'AWAY');
    const single = (await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [sa], stake: '10.00', idempotencyKey: idem() })).body;
    const multi = (await ctx.http.post('/api/bets').set(auth(u.token)).send({ legs: [sa, sb], stake: '10.00', idempotencyKey: idem() })).body;
    expect(multi.type).toBe('MULTIPLE');
    await ctx.http.post(`/api/admin/sandbox/matches/${a.id}/result`).set(auth(admin.token)).send({ status: 'CANCELLED' });
    expect((await ctx.http.get(`/api/bets/${single.id}`).set(auth(u.token))).body.status).toBe('VOID');
    expect((await ctx.http.get(`/api/bets/${multi.id}`).set(auth(u.token))).body.status).toBe('OPEN');
    await ctx.http.post(`/api/admin/sandbox/matches/${b.id}/result`).set(auth(admin.token)).send({ status: 'FINISHED', homeGoals: 0, awayGoals: 1 });
    const mb = (await ctx.http.get(`/api/bets/${multi.id}`).set(auth(u.token))).body;
    expect(mb.status).toBe('WON');
    expect(BigInt(mb.payout)).toBe(BigInt(Math.floor(1000 * sb.odds))); // void leg counts as 1.00
    expect(await balance(u.token)).toBe(8000n + 1000n + BigInt(mb.payout));
    await reconcileOk();
  });

  it('keeps the ledger append-only and balanced at the database level', async () => {
    await expect(ctx.dbs.pool.query(`UPDATE ledger_entries SET amount = amount + 1`)).rejects.toThrow(/append-only/);
    await expect(ctx.dbs.pool.query(`DELETE FROM ledger_transactions`)).rejects.toThrow(/append-only/);
    await expect(ctx.dbs.pool.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    const c = await ctx.dbs.pool.connect();
    try {
      await c.query('BEGIN');
      const acc = (await c.query(`SELECT id FROM ledger_accounts LIMIT 2`)).rows;
      const t = (await c.query(`INSERT INTO ledger_transactions(type, idempotency_key) VALUES ('ADJUSTMENT','bad-tx') RETURNING id`)).rows[0];
      await c.query(`INSERT INTO ledger_entries(transaction_id, account_id, amount, balance_after) VALUES ($1,$2,100,0),($1,$3,-99,0)`, [t.id, acc[0].id, acc[1].id]);
      await expect(c.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    await reconcileOk();
  });
});
