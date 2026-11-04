import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { fitRatings, HistoricalMatch, MODEL_VERSION, priceMatch, RatingModel, PricingResult } from '@athosbet/odds-engine';
import { oddsToK, parseMarketKey } from '@athosbet/shared';
import { Database, DbService } from '../db/db.service';
import { competitions, externalOdds, markets, matches, modelRuns, odds, probabilitySnapshots, teamAvailability, teams, matchExternalIds } from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { EventBus } from '../realtime/events';
import { config } from '../config';
import { CATALOG } from '../sports/catalog';
import { OddsApiClient, normalizeTeamName } from './odds-api.client';

const DAY = 86_400_000;
export const PRICING_HORIZON_DAYS = 14;

@Injectable()
export class PricingService {
  private readonly log = new Logger(PricingService.name);
  private model: { model: RatingModel; runId: string; at: number } | null = null;

  constructor(private readonly dbs: DbService, private readonly settings: SettingsService, private readonly bus: EventBus) {}

  async history(): Promise<HistoricalMatch[]> {
    const rows = await this.dbs.db.select({
      homeId: matches.homeTeamId, awayId: matches.awayTeamId, homeGoals: matches.homeGoals, awayGoals: matches.awayGoals, date: matches.kickoffAt, neutral: matches.neutral,
    }).from(matches).where(and(eq(matches.status, 'FINISHED'), gt(matches.kickoffAt, new Date(Date.now() - 730 * DAY))));
    return rows.map((r) => ({ ...r, homeGoals: r.homeGoals!, awayGoals: r.awayGoals! }));
  }

  /** Fits one global Dixon–Coles model over all finished matches (time-decayed) and stores the run. */
  async fit(asOf = new Date()) {
    const hist = await this.history();
    const model = fitRatings(hist, { asOf });
    const [run] = await this.dbs.db.insert(modelRuns).values({
      scope: 'global', modelVersion: MODEL_VERSION, fittedAt: asOf, nMatches: model.nMatches,
      params: { mu: model.mu, homeAdvantage: model.homeAdvantage, rho: model.rho, teams: model.teams, logLikelihood: model.logLikelihood },
    }).returning();
    this.model = { model, runId: run.id, at: Date.now() };
    return { model, runId: run.id, history: hist };
  }

  private async currentModel() {
    if (this.model && Date.now() - this.model.at < 30 * 60_000) return { ...this.model, history: await this.history() };
    return this.fit();
  }

  /** Prices every upcoming, bettable match. Returns the number of matches priced. */
  async priceUpcoming(matchIds?: string[]) {
    const { model, runId, history } = await this.currentModel();
    const cfg = await this.settings.get('pricing');
    const where = [
      eq(matches.status, 'SCHEDULED'),
      gt(matches.kickoffAt, new Date()),
      lte(matches.kickoffAt, new Date(Date.now() + PRICING_HORIZON_DAYS * DAY)),
      eq(competitions.enabled, true),
    ];
    if (matchIds?.length) where.push(inArray(matches.id, matchIds));
    const list = await this.dbs.db.select({ m: matches, c: competitions }).from(matches)
      .innerJoin(competitions, eq(competitions.id, matches.competitionId)).where(and(...where));
    let n = 0;
    for (const { m, c } of list) {
      const avail = await this.dbs.db.select().from(teamAvailability).where(eq(teamAvailability.matchId, m.id));
      const av = (tid: string) => {
        const r = avail.find((x) => x.teamId === tid);
        return r ? { attackLoss: Number(r.attackLoss), defenseLoss: Number(r.defenseLoss) } : undefined;
      };
      const [ext] = await this.dbs.db.select().from(externalOdds).where(and(eq(externalOdds.matchId, m.id), gt(externalOdds.fetchedAt, new Date(Date.now() - 12 * 3600_000)))).orderBy(desc(externalOdds.fetchedAt)).limit(1);
      const result = priceMatch({
        model, homeId: m.homeTeamId, awayId: m.awayTeamId,
        context: { neutral: m.neutral, history, asOf: new Date(), homeAvailability: av(m.homeTeamId), awayAvailability: av(m.awayTeamId) },
        external: (ext?.data as any) ?? undefined,
        config: cfg,
      });
      await this.publish(m.id, result, runId, !c.bettingEnabled);
      n++;
    }
    return n;
  }

  /**
   * Publishes prices atomically: new odds versions only when a price moved; superseded versions are
   * kept (is_current=false) so every accepted bet references the exact price it was struck at.
   */
  async publish(matchId: string, r: PricingResult, runId: string | null, competitionBlocked = false) {
    await this.dbs.tx(async (tx) => {
      await tx.insert(probabilitySnapshots).values({
        matchId, modelRunId: runId, modelVersion: r.modelVersion, lambdaHome: r.lambdas.home, lambdaAway: r.lambdas.away,
        status: r.status, suspensionReason: r.suspensionReason ?? null,
        fair: r.markets.map((mk) => ({ key: mk.key, probs: Object.fromEntries(mk.selections.map((s) => [s.key, s.fairProb])) })),
        external: r.external as any, factors: r.factors, diagnostics: r.diagnostics,
      });
      const existing = await tx.select().from(markets).where(eq(markets.matchId, matchId)).for('update');
      if (r.status === 'SUSPENDED') {
        for (const mk of existing) {
          if (mk.status === 'OPEN') await tx.update(markets).set({ status: 'SUSPENDED', suspensionReason: r.suspensionReason, updatedAt: new Date() }).where(eq(markets.id, mk.id));
        }
        return;
      }
      for (const pm of r.markets) {
        let mk = existing.find((e) => e.key === pm.key);
        const autoStatus = competitionBlocked ? 'SUSPENDED' : pm.status;
        const reason = competitionBlocked ? 'COMPETITION_DISABLED' : pm.suspensionReason ?? null;
        if (!mk) {
          [mk] = await tx.insert(markets).values({ matchId, key: pm.key, type: pm.type, line: pm.line === null ? null : String(pm.line), status: autoStatus, suspensionReason: reason }).returning();
        } else if (['SETTLED', 'VOID', 'CLOSED'].includes(mk.status)) {
          continue;
        }
        const cur = await tx.select().from(odds).where(and(eq(odds.marketId, mk.id), eq(odds.isCurrent, true)));
        let changed = false;
        for (const s of pm.selections) {
          const k = oddsToK(s.odds);
          const c = cur.find((x) => x.selection === s.key);
          if (c && c.oddsK === k) continue;
          changed = true;
          if (c) await tx.update(odds).set({ isCurrent: false }).where(eq(odds.id, c.id));
          await tx.insert(odds).values({ marketId: mk.id, selection: s.key, oddsK: k, fairProb: s.fairProb, version: (c?.version ?? 0) + 1, isCurrent: true });
        }
        const nextStatus = mk.manualSuspension ? 'SUSPENDED' : autoStatus;
        if (changed || nextStatus !== mk.status) {
          await tx.update(markets).set({
            status: nextStatus, suspensionReason: mk.manualSuspension ? mk.suspensionReason : reason,
            version: changed ? mk.version + 1 : mk.version, updatedAt: new Date(),
          }).where(eq(markets.id, mk.id));
        }
      }
    });
    this.bus.emit({ type: 'odds.updated', matchId });
  }

  /**
   * Markets close at kick-off (pre-match only; in-play is a later phase). Postponed / interrupted
   * fixtures are suspended instead, so that they can be re-opened if the match is re-scheduled.
   */
  async closeStarted() {
    const sus = await this.dbs.db.execute(sql`
      UPDATE markets SET status = 'SUSPENDED', suspension_reason = 'MATCH_' || m.status, updated_at = now()
      FROM matches m WHERE m.id = markets.match_id AND markets.status = 'OPEN' AND m.status IN ('POSTPONED','SUSPENDED')
      RETURNING markets.match_id`);
    const closed = await this.dbs.db.execute(sql`
      UPDATE markets SET status = 'CLOSED', updated_at = now()
      FROM matches m WHERE m.id = markets.match_id AND markets.status IN ('OPEN','SUSPENDED')
        AND (m.status IN ('LIVE','FINISHED','CANCELLED','ABANDONED') OR (m.status = 'SCHEDULED' AND m.kickoff_at <= now()))
      RETURNING markets.match_id`);
    const ids = [...new Set([...(sus.rows as any[]), ...(closed.rows as any[])].map((x) => x.match_id))];
    for (const id of ids) this.bus.emit({ type: 'odds.updated', matchId: id });
    return ids.length;
  }

  async suspendMatches(ids: string[], reason: string) {
    if (!ids.length) return;
    await this.dbs.db.update(markets).set({ status: 'SUSPENDED', suspensionReason: reason, updatedAt: new Date() })
      .where(and(inArray(markets.matchId, ids), eq(markets.status, 'OPEN')));
    for (const id of ids) this.bus.emit({ type: 'odds.updated', matchId: id });
  }

  /** Fetches and stores consensus prices from The Odds API for competitions that have a sport key. */
  async syncExternalOdds() {
    const key = config().ODDS_API_KEY;
    if (!key) return { skipped: 'ODDS_API_KEY not configured' };
    const client = new OddsApiClient(key, config().ODDS_API_BASE_URL);
    let matched = 0;
    const errors: string[] = [];
    const enabled = await this.dbs.db.select().from(competitions).where(eq(competitions.enabled, true));
    for (const c of enabled) {
      const sportKey = CATALOG.find((x) => x.slug === c.slug)?.oddsApiKey;
      if (!sportKey) continue;
      try {
        const events = await client.events(sportKey);
        const upcoming = await this.dbs.db.select({ m: matches, h: teams.name }).from(matches)
          .innerJoin(teams, eq(teams.id, matches.homeTeamId))
          .where(and(eq(matches.competitionId, c.id), eq(matches.status, 'SCHEDULED'), gt(matches.kickoffAt, new Date())));
        const away = new Map((await this.dbs.db.select({ id: teams.id, name: teams.name }).from(teams)).map((t) => [t.id, t.name]));
        for (const e of events) {
          const hit = upcoming.find(({ m, h }) =>
            Math.abs(m.kickoffAt.getTime() - e.commenceTime.getTime()) < 3 * 3600_000 &&
            normalizeTeamName(h) === normalizeTeamName(e.homeTeam) && normalizeTeamName(away.get(m.awayTeamId) ?? '') === normalizeTeamName(e.awayTeam));
          if (!hit) continue;
          await this.dbs.db.insert(externalOdds).values({ matchId: hit.m.id, source: 'the-odds-api', bookmakers: e.consensus.bookmakers ?? 0, data: e.consensus as any });
          await this.dbs.db.insert(matchExternalIds).values({ matchId: hit.m.id, source: 'the-odds-api', externalId: e.id }).onConflictDoNothing();
          matched++;
        }
      } catch (e: any) {
        errors.push(`${c.slug}: ${e.message}`);
      }
    }
    return { matched, errors };
  }

  /** Public odds board for a match. */
  async marketsFor(matchId: string, tx?: Database) {
    const db = tx ?? this.dbs.db;
    const mks = await db.select().from(markets).where(eq(markets.matchId, matchId));
    if (!mks.length) return [];
    const cur = await db.select().from(odds).where(and(inArray(odds.marketId, mks.map((m) => m.id)), eq(odds.isCurrent, true)));
    return mks.map((m) => ({
      id: m.id, key: m.key, type: m.type, line: m.line === null ? null : Number(m.line), status: m.status, suspensionReason: m.suspensionReason, version: m.version,
      selections: cur.filter((o) => o.marketId === m.id).map((o) => ({ key: o.selection, oddsId: o.id, odds: o.oddsK / 1000, oddsK: o.oddsK, version: o.version }))
        .sort((a, b) => orderOf(m.key, a.key) - orderOf(m.key, b.key)),
    })).sort((a, b) => marketOrder(a.key) - marketOrder(b.key));
  }
}

const MARKET_ORDER = ['MATCH_RESULT', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'BOTH_TEAMS_TO_SCORE', 'TOTAL_GOALS', 'CORRECT_SCORE'];
function marketOrder(key: string) {
  const { type, line } = parseMarketKey(key);
  return MARKET_ORDER.indexOf(type) * 100 + (line ?? 0);
}
const SEL_ORDER = ['HOME', 'HOME_DRAW', 'DRAW', 'HOME_AWAY', 'AWAY', 'DRAW_AWAY', 'YES', 'NO', 'OVER', 'UNDER'];
function orderOf(_mk: string, sel: string) {
  const i = SEL_ORDER.indexOf(sel);
  if (i >= 0) return i;
  const m = /^(\d+)-(\d+)$/.exec(sel);
  if (m) return 100 + Number(m[1]) * 10 + Number(m[2]);
  return 1000 + sel.length;
}
