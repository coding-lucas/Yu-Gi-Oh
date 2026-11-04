import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { walkForwardBacktest } from '@athosbet/odds-engine';
import { AuthUser, Client, ClientInfo, CurrentUser, Roles } from '../common/auth';
import { ZodPipe } from '../common/zod';
import { DbService } from '../db/db.service';
import { bets, competitions, jurisdictions, markets, matches, payments, providerSyncRuns, suspiciousActivities, users, matchResultHistory, modelRuns, teams } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { RiskService } from '../risk/risk.service';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentsService, serializePayment } from '../payments/payments.service';
import { PricingService } from '../odds/pricing.service';
import { SyncService } from '../sports/sync.service';
import { SettlementService } from '../settlement/settlement.service';
import { BetsService } from '../bets/bets.service';
import { EventBus } from '../realtime/events';
import { err } from '../common/errors';
import { config } from '../config';

const ser = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const margin = z.number().min(0).max(0.4);
const PricingPatch = z.object({
  margins: z.object({ MATCH_RESULT: margin, DOUBLE_CHANCE: margin, DRAW_NO_BET: margin, BOTH_TEAMS_TO_SCORE: margin, TOTAL_GOALS: margin, CORRECT_SCORE: margin }).partial().optional(),
  marginMethod: z.enum(['PROPORTIONAL', 'POWER']).optional(),
  minTeamMatches: z.number().int().min(1).max(100).optional(),
  minTeamMatchesCorrectScore: z.number().int().min(1).max(200).optional(),
  externalWeight: z.number().min(0).max(1).optional(),
  maxExternalDeviation: z.number().min(0.01).max(0.5).optional(),
  maxOdds: z.number().min(2).max(1000).optional(),
}).strict();
const RiskPatch = z.object({
  minStake: z.number().int().positive(), maxStake: z.number().int().positive(), maxPayout: z.number().int().positive(),
  maxLiabilityPerSelection: z.number().int().positive(), maxLegs: z.number().int().min(1).max(20),
  largeWithdrawalReview: z.number().int().positive(), largeDepositFlag: z.number().int().positive(),
}).partial().strict();

@ApiTags('admin')
@Controller('admin')
@Roles('ADMIN', 'RISK', 'SUPPORT')
export class AdminController {
  constructor(
    private readonly dbs: DbService, private readonly audit: AuditService, private readonly settings: SettingsService,
    private readonly risk: RiskService, private readonly ledger: LedgerService, private readonly payments: PaymentsService,
    private readonly pricing: PricingService, private readonly sync: SyncService, private readonly settlement: SettlementService,
    private readonly betsSvc: BetsService, private readonly bus: EventBus,
  ) {}

  @Get('dashboard')
  async dashboard() {
    return { kpis: await this.risk.kpis(), series: await this.risk.volumeSeries(), exposure: await this.risk.exposure(10) };
  }

  @Get('exposure')
  exposure() {
    return this.risk.exposure(200);
  }

  @Get('users')
  async users(@Query('q') q?: string) {
    const rows = await this.dbs.db.select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role, status: users.status, country: users.country, kycStatus: users.kycStatus, mfaEnabled: users.mfaEnabled, createdAt: users.createdAt })
      .from(users).where(q ? sql`${users.email} ILIKE ${'%' + q + '%'}` : undefined).orderBy(desc(users.createdAt)).limit(200);
    return rows;
  }

  @Roles('ADMIN')
  @Patch('users/:id')
  async updateUser(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']).optional(), role: z.enum(['USER', 'SUPPORT', 'RISK', 'ADMIN']).optional(), kycStatus: z.enum(['NONE', 'PENDING', 'VERIFIED', 'REJECTED']).optional() }).strict())) b: any) {
    if (id === a.id && b.role && b.role !== 'ADMIN') throw err.badRequest('CANNOT_DEMOTE_SELF');
    const [before] = await this.dbs.db.select().from(users).where(eq(users.id, id));
    if (!before) throw err.notFound();
    const [after] = await this.dbs.db.update(users).set({ ...b, updatedAt: new Date() }).where(eq(users.id, id)).returning();
    await this.audit.log({ actorId: a.id, actorRole: a.role, action: 'admin.user.update', entityType: 'user', entityId: id, before: { status: before.status, role: before.role, kycStatus: before.kycStatus }, after: b, ip: c.ip });
    return { id: after.id, status: after.status, role: after.role, kycStatus: after.kycStatus };
  }

  @Get('matches')
  async matches(@Query('status') status?: string) {
    const r = await this.dbs.db.execute(sql`
      SELECT m.id, m.kickoff_at, m.status, m.home_goals, m.away_goals, m.result_version, m.result_source, m.featured, m.last_synced_at, c.name competition, ht.name home, at.name away,
        (SELECT COUNT(*) FROM markets mk WHERE mk.match_id = m.id AND mk.status='OPEN')::int open_markets,
        (SELECT COUNT(*) FROM markets mk WHERE mk.match_id = m.id AND mk.status='SUSPENDED')::int suspended_markets,
        (SELECT COUNT(DISTINCT bs.bet_id) FROM bet_selections bs WHERE bs.match_id = m.id)::int bets
      FROM matches m JOIN competitions c ON c.id=m.competition_id JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id
      WHERE m.kickoff_at > now() - interval '3 days' AND m.kickoff_at < now() + interval '14 days' ${status ? sql`AND m.status = ${status}` : sql``}
      ORDER BY m.kickoff_at LIMIT 500`);
    return r.rows;
  }

  @Get('matches/:id')
  async match(@Param('id', ParseUUIDPipe) id: string) {
    const [m] = await this.dbs.db.select().from(matches).where(eq(matches.id, id));
    if (!m) throw err.notFound();
    return { match: m, markets: await this.pricing.marketsFor(id), resultHistory: await this.dbs.db.select().from(matchResultHistory).where(eq(matchResultHistory.matchId, id)).orderBy(matchResultHistory.version) };
  }

  @Roles('ADMIN', 'RISK')
  @HttpCode(200)
  @Post('markets/:id/suspend')
  async suspend(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ suspended: z.boolean(), reason: z.string().max(200).default('MANUAL') }))) b: { suspended: boolean; reason: string }) {
    const [before] = await this.dbs.db.select().from(markets).where(eq(markets.id, id));
    if (!before) throw err.notFound();
    if (['SETTLED', 'VOID', 'CLOSED'].includes(before.status)) throw err.conflict('MARKET_FINAL');
    const [after] = await this.dbs.db.update(markets).set({ manualSuspension: b.suspended, status: b.suspended ? 'SUSPENDED' : 'OPEN', suspensionReason: b.suspended ? b.reason : null, updatedAt: new Date() }).where(eq(markets.id, id)).returning();
    await this.audit.log({ actorId: a.id, actorRole: a.role, action: b.suspended ? 'admin.market.suspend' : 'admin.market.resume', entityType: 'market', entityId: id, before: { status: before.status }, after: { status: after.status, reason: b.reason }, ip: c.ip });
    this.bus.emit({ type: 'odds.updated', matchId: before.matchId });
    if (!b.suspended) await this.pricing.priceUpcoming([before.matchId]);
    return after;
  }

  @Roles('ADMIN', 'RISK')
  @HttpCode(200)
  @Post('matches/:id/suspend')
  async suspendMatch(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ suspended: z.boolean() }))) b: { suspended: boolean }) {
    await this.dbs.db.update(markets).set({ manualSuspension: b.suspended, status: b.suspended ? 'SUSPENDED' : 'OPEN', suspensionReason: b.suspended ? 'MANUAL' : null, updatedAt: new Date() })
      .where(and(eq(markets.matchId, id), inArray(markets.status, ['OPEN', 'SUSPENDED'])));
    await this.audit.log({ actorId: a.id, actorRole: a.role, action: b.suspended ? 'admin.match.suspend' : 'admin.match.resume', entityType: 'match', entityId: id, ip: c.ip });
    if (!b.suspended) await this.pricing.priceUpcoming([id]);
    this.bus.emit({ type: 'odds.updated', matchId: id });
    return { ok: true };
  }

  @Roles('ADMIN')
  @Patch('matches/:id')
  async patchMatch(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ featured: z.boolean() }))) b: { featured: boolean }) {
    await this.dbs.db.update(matches).set({ featured: b.featured }).where(eq(matches.id, id));
    await this.audit.log({ actorId: a.id, actorRole: a.role, action: 'admin.match.feature', entityType: 'match', entityId: id, after: b, ip: c.ip });
    return { ok: true };
  }

  /**
   * SANDBOX ONLY: records an operator-entered official result (or correction) through the same
   * ingestion path as the provider and locks it against provider overwrite. Disabled in REAL mode.
   */
  @Roles('ADMIN')
  @HttpCode(200)
  @Post('sandbox/matches/:id/result')
  async setResult(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ status: z.enum(['FINISHED', 'CANCELLED', 'ABANDONED', 'POSTPONED']), homeGoals: z.number().int().min(0).max(30).optional(), awayGoals: z.number().int().min(0).max(30).optional() }))) b: { status: 'FINISHED' | 'CANCELLED' | 'ABANDONED' | 'POSTPONED'; homeGoals?: number; awayGoals?: number }) {
    if (config().REAL_MONEY_ENABLED) throw err.forbidden('SANDBOX_ONLY');
    if (b.status === 'FINISHED' && (b.homeGoals === undefined || b.awayGoals === undefined)) throw err.badRequest('SCORE_REQUIRED');
    const out = await this.dbs.tx(async (tx) => {
      const [m] = await tx.select().from(matches).where(eq(matches.id, id)).for('update');
      if (!m) throw err.notFound();
      const finished = b.status === 'FINISHED';
      const changed = m.status !== b.status || m.homeGoals !== (b.homeGoals ?? null) || m.awayGoals !== (b.awayGoals ?? null);
      if (!changed) return m;
      const version = ['FINISHED', 'CANCELLED', 'ABANDONED'].includes(b.status) ? m.resultVersion + 1 : m.resultVersion;
      const [u] = await tx.update(matches).set({
        status: b.status, homeGoals: finished ? b.homeGoals! : null, awayGoals: finished ? b.awayGoals! : null, resultVersion: version,
        resultSource: 'ADMIN', resultLocked: true, kickoffAt: finished && m.kickoffAt > new Date() ? new Date() : m.kickoffAt, updatedAt: new Date(),
      }).where(eq(matches.id, id)).returning();
      if (version !== m.resultVersion) await tx.insert(matchResultHistory).values({ matchId: id, version, status: b.status, homeGoals: b.homeGoals ?? null, awayGoals: b.awayGoals ?? null, source: `ADMIN:${a.id}` });
      await this.audit.log({ actorId: a.id, actorRole: a.role, action: 'admin.sandbox.result', entityType: 'match', entityId: id, before: { status: m.status, homeGoals: m.homeGoals, awayGoals: m.awayGoals }, after: b, ip: c.ip }, tx);
      return u;
    });
    await this.pricing.closeStarted();
    const settlement = await this.settlement.settleMatch(id);
    this.bus.emit({ type: 'match.updated', matchId: id, status: out.status });
    return { match: out, settlement };
  }

  @Get('bets')
  async bets(@Query('status') status?: string) {
    const rows = await this.dbs.db.select({ b: bets, email: users.email }).from(bets).innerJoin(users, eq(users.id, bets.userId))
      .where(status ? eq(bets.status, status as any) : undefined).orderBy(desc(bets.placedAt)).limit(200);
    return ser(rows.map((r) => ({ ...r.b, email: r.email })));
  }

  @Get('bets/:id')
  async bet(@Param('id', ParseUUIDPipe) id: string) {
    const bet = await this.betsSvc.get(null, id);
    const s = await this.dbs.db.execute(sql`SELECT * FROM settlements WHERE bet_id = ${id} ORDER BY version`);
    const ledger = await this.dbs.db.execute(sql`SELECT t.id, t.type, t.idempotency_key, t.created_at, json_agg(json_build_object('account', a.code, 'amount', e.amount::text) ORDER BY e.id) entries
      FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id JOIN ledger_accounts a ON a.id=e.account_id
      WHERE t.reference_type='bet' AND t.reference_id=${id} OR t.reverses_id IN (SELECT id FROM ledger_transactions WHERE reference_id=${id}) GROUP BY t.id ORDER BY t.created_at`);
    return ser({ bet, settlements: s.rows, ledger: ledger.rows });
  }

  @Get('payments')
  async paymentsList(@Query('status') status?: string) {
    const rows = await this.dbs.db.select().from(payments).where(status ? eq(payments.status, status as any) : undefined).orderBy(desc(payments.createdAt)).limit(200);
    return rows.map(serializePayment);
  }

  @Roles('ADMIN', 'RISK')
  @HttpCode(200)
  @Post('payments/:id/approve')
  async approve(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.approveWithdrawal(id, a);
  }

  @Roles('ADMIN', 'RISK')
  @HttpCode(200)
  @Post('payments/:id/reject')
  async reject(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ reason: z.string().min(2).max(200) }))) b: { reason: string }) {
    await this.payments.rejectWithdrawal(id, b.reason, a);
    return { ok: true };
  }

  @Get('payments/providers')
  providers() {
    return this.payments.registry.status();
  }

  @Get('payments/eligibility')
  eligibility() {
    return this.payments.eligibility.list().then(ser);
  }

  /**
   * Records AthosBet eligibility / regulatory approval / gateway approval for a (provider, method,
   * country, mode) and enables it. Enabling requires all three approvals and an evidence reference.
   */
  @Roles('ADMIN')
  @Patch('payments/eligibility/:id')
  async setEligibility(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({
    athosbetEligible: z.boolean().optional(), regulatoryApproved: z.boolean().optional(), gatewayApproved: z.boolean().optional(), enabled: z.boolean().optional(),
    priority: z.number().int().min(1).max(10000).optional(), evidence: z.string().max(500).optional(),
    directions: z.array(z.enum(['DEPOSIT', 'WITHDRAWAL', 'REFUND'])).min(1).optional(),
    minAmount: z.number().int().positive().optional(), maxAmount: z.number().int().positive().optional(),
  }).strict())) b: any) {
    const patch = { ...b, minAmount: b.minAmount !== undefined ? BigInt(b.minAmount) : undefined, maxAmount: b.maxAmount !== undefined ? BigInt(b.maxAmount) : undefined };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    return ser(await this.payments.eligibility.update(id, patch, a, c.ip));
  }

  @Roles('ADMIN', 'RISK')
  @HttpCode(200)
  @Post('payments/:id/refund')
  refund(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ amount: z.number().int().positive().optional(), reason: z.string().min(3).max(200), idempotencyKey: z.string().min(8).max(100) }))) b: { amount?: number; reason: string; idempotencyKey: string }) {
    return this.payments.refund(id, b.amount !== undefined ? BigInt(b.amount) : null, b.reason, a, b.idempotencyKey);
  }

  @Roles('ADMIN', 'RISK')
  @HttpCode(200)
  @Post('payments/reconcile/:provider')
  reconcilePayments(@CurrentUser() a: AuthUser, @Param('provider') provider: string) {
    void this.audit.log({ actorId: a.id, actorRole: a.role, action: 'admin.payments.reconcile', entityType: 'provider', entityId: provider });
    return this.payments.reconcile(provider);
  }

  @Get('payments/reconciliation-runs')
  reconciliationRuns() {
    return this.payments.reconciliationRuns();
  }

  @Roles('ADMIN')
  @HttpCode(200)
  @Post('payments/sync')
  syncPayments() {
    return this.payments.syncPending(0);
  }

  /** Team visual identity: only crests the operator holds rights to (licensed feed / club authorisation). */
  @Roles('ADMIN')
  @Patch('teams/:id')
  async patchTeam(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({
    logoUrl: z.string().url().startsWith('https://').max(500).nullable().optional(), logoSource: z.string().max(120).optional(),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    crestPattern: z.enum(['solid', 'stripes', 'hoops', 'sash', 'halves']).optional(),
  }).strict())) b: any) {
    const [before] = await this.dbs.db.select().from(teams).where(eq(teams.id, id));
    if (!before) throw err.notFound();
    if (b.logoUrl && !b.logoSource) throw err.badRequest('LOGO_SOURCE_REQUIRED');
    if (b.logoSource) b.logoSource = `ADMIN: ${b.logoSource}`;
    const [after] = await this.dbs.db.update(teams).set(b).where(eq(teams.id, id)).returning();
    await this.audit.log({ actorId: a.id, actorRole: a.role, action: 'admin.team.update', entityType: 'team', entityId: id, before, after, ip: c.ip });
    return after;
  }

  @Get('teams')
  teamsList(@Query('q') q?: string) {
    return this.dbs.db.select().from(teams).where(q ? sql`${teams.name} ILIKE ${'%' + q + '%'}` : undefined).orderBy(teams.name).limit(300);
  }

  @Get('ledger/reconcile')
  reconcile() {
    return this.ledger.reconcile();
  }

  @Get('ledger/transactions')
  async ledgerTx() {
    const r = await this.dbs.db.execute(sql`SELECT t.id, t.type, t.idempotency_key, t.reference_type, t.reference_id, t.created_at,
      json_agg(json_build_object('account', a.code, 'amount', e.amount::text) ORDER BY e.id) entries
      FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id JOIN ledger_accounts a ON a.id=e.account_id
      GROUP BY t.id ORDER BY t.created_at DESC LIMIT 200`);
    return r.rows;
  }

  @Get('settings')
  async getSettings() {
    return { pricing: await this.settings.get('pricing'), risk: await this.settings.get('risk'), realMoneyEnabled: config().REAL_MONEY_ENABLED, dataProvider: this.sync.providerName };
  }

  @Roles('ADMIN', 'RISK')
  @Patch('settings/pricing')
  async setPricing(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Body(new ZodPipe(PricingPatch)) b: any) {
    const r = await this.settings.set('pricing', b, a, c.ip);
    await this.pricing.priceUpcoming();
    return r;
  }

  @Roles('ADMIN', 'RISK')
  @Patch('settings/risk')
  setRisk(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Body(new ZodPipe(RiskPatch)) b: any) {
    return this.settings.set('risk', b, a, c.ip);
  }

  @Get('competitions')
  competitions() {
    return this.dbs.db.select().from(competitions).orderBy(competitions.priority);
  }

  @Roles('ADMIN')
  @Patch('competitions/:id')
  async patchCompetition(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ enabled: z.boolean().optional(), bettingEnabled: z.boolean().optional(), priority: z.number().int().optional() }).strict())) b: any) {
    const [before] = await this.dbs.db.select().from(competitions).where(eq(competitions.id, id));
    if (!before) throw err.notFound();
    const [after] = await this.dbs.db.update(competitions).set({ ...b, updatedAt: new Date() }).where(eq(competitions.id, id)).returning();
    await this.audit.log({ actorId: a.id, actorRole: a.role, action: 'admin.competition.update', entityType: 'competition', entityId: id, before: { enabled: before.enabled, bettingEnabled: before.bettingEnabled }, after: b, ip: c.ip });
    if (b.bettingEnabled === false) {
      await this.dbs.db.update(markets).set({ status: 'SUSPENDED', suspensionReason: 'COMPETITION_DISABLED' })
        .where(and(eq(markets.status, 'OPEN'), sql`${markets.matchId} IN (SELECT id FROM matches WHERE competition_id = ${id})`));
    } else if (b.bettingEnabled === true) {
      await this.pricing.priceUpcoming();
    }
    return after;
  }

  @Get('jurisdictions')
  jurisdictions() {
    return this.dbs.db.select().from(jurisdictions).orderBy(jurisdictions.country);
  }

  @Roles('ADMIN')
  @Patch('jurisdictions/:country')
  async setJurisdiction(@CurrentUser() a: AuthUser, @Client() c: ClientInfo, @Param('country') country: string, @Body(new ZodPipe(z.object({ status: z.enum(['BLOCKED', 'SANDBOX_ONLY', 'LICENSED']), note: z.string().max(300).optional() }))) b: { status: 'BLOCKED' | 'SANDBOX_ONLY' | 'LICENSED'; note?: string }) {
    if (!/^[A-Za-z]{2}$/.test(country)) throw err.badRequest('INVALID_COUNTRY');
    // LICENSED must reflect a real licence; it is still inert while REAL_MONEY_ENABLED=false.
    const cc = country.toUpperCase();
    const [before] = await this.dbs.db.select().from(jurisdictions).where(eq(jurisdictions.country, cc));
    await this.dbs.db.insert(jurisdictions).values({ country: cc, status: b.status, note: b.note }).onConflictDoUpdate({ target: jurisdictions.country, set: { status: b.status, note: b.note, updatedAt: new Date() } });
    await this.audit.log({ actorId: a.id, actorRole: a.role, action: 'admin.jurisdiction.update', entityType: 'jurisdiction', entityId: cc, before, after: b, ip: c.ip });
    return { ok: true };
  }

  @Get('suspicious')
  async suspicious(@Query('status') status?: string) {
    const rows = await this.dbs.db.select().from(suspiciousActivities).where(status ? eq(suspiciousActivities.status, status as any) : undefined).orderBy(desc(suspiciousActivities.createdAt)).limit(200);
    return rows;
  }

  @Roles('ADMIN', 'RISK')
  @Patch('suspicious/:id')
  async review(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ status: z.enum(['REVIEWED', 'ESCALATED']) }))) b: { status: 'REVIEWED' | 'ESCALATED' }) {
    await this.dbs.db.update(suspiciousActivities).set({ status: b.status }).where(eq(suspiciousActivities.id, id));
    await this.audit.log({ actorId: a.id, actorRole: a.role, action: 'admin.suspicious.review', entityType: 'suspicious_activity', entityId: id, after: b });
    return { ok: true };
  }

  @Get('audit')
  auditLogs(@Query('entityType') entityType?: string, @Query('entityId') entityId?: string, @Query('action') action?: string) {
    return this.audit.list({ entityType, entityId, action, limit: 300 });
  }

  @Get('sync-runs')
  syncRuns() {
    return this.dbs.db.select().from(providerSyncRuns).orderBy(desc(providerSyncRuns.id)).limit(100);
  }

  @Get('models')
  async models() {
    const rows = await this.dbs.db.select({ id: modelRuns.id, scope: modelRuns.scope, modelVersion: modelRuns.modelVersion, fittedAt: modelRuns.fittedAt, nMatches: modelRuns.nMatches, metrics: modelRuns.metrics, homeAdvantage: sql`(params->>'homeAdvantage')::float`, rho: sql`(params->>'rho')::float` })
      .from(modelRuns).orderBy(desc(modelRuns.createdAt)).limit(30);
    return rows;
  }

  /** Walk-forward backtest on stored history: Brier, log loss, RPS and calibration. */
  @Roles('ADMIN', 'RISK')
  @HttpCode(200)
  @Post('models/backtest')
  async backtest(@CurrentUser() a: AuthUser) {
    const hist = await this.pricing.history();
    if (hist.length < 200) throw err.unprocessable('NOT_ENOUGH_HISTORY', { matches: hist.length });
    const report = walkForwardBacktest(hist, { warmup: Math.floor(hist.length * 0.4), refitEvery: 50, minTeamMatches: 8, useForm: false });
    const { runId } = await this.pricing.fit();
    await this.dbs.db.update(modelRuns).set({ metrics: report as any }).where(eq(modelRuns.id, runId));
    await this.audit.log({ actorId: a.id, actorRole: a.role, action: 'admin.model.backtest', entityType: 'model_run', entityId: runId, after: { n: report.n, brier: report.model.brier, logLoss: report.model.logLoss } });
    return report;
  }

  @Roles('ADMIN')
  @HttpCode(200)
  @Post('jobs/:job')
  async runJob(@CurrentUser() a: AuthUser, @Param('job') job: string) {
    let result: unknown;
    switch (job) {
      case 'sync': result = await this.sync.syncFixtures(); break;
      case 'history': result = await this.sync.syncHistory(); break;
      case 'coverage': result = await this.sync.checkCoverage(); break;
      case 'price': result = { priced: await this.pricing.priceUpcoming() }; break;
      case 'external-odds': result = await this.pricing.syncExternalOdds(); break;
      case 'settle': result = await this.settlement.settlePending(); break;
      case 'close': result = { closed: await this.pricing.closeStarted() }; break;
      default: throw err.notFound('UNKNOWN_JOB');
    }
    await this.audit.log({ actorId: a.id, actorRole: a.role, action: `admin.job.${job}`, entityType: 'job', entityId: job });
    return ser(result);
  }
}
