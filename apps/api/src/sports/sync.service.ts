import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Database, DbService } from '../db/db.service';
import { competitions, matchExternalIds, matches, matchResultHistory, providerSyncRuns, teamAvailability, teams, MatchStatus } from '../db/schema';
import { CATALOG, seasonFor } from './catalog';
import { ProviderError, ProviderFixture, ProviderTeam, SportsProvider } from './providers/types';
import { SPORTS_PROVIDER } from './sports-provider.factory';
import { DEMO_COMPETITIONS } from './providers/demo.provider';
import { EventBus } from '../realtime/events';

const DAY = 86_400_000;
/** a match moved by more than this from its original kick-off is treated as a new fixture (bets void) */
export const POSTPONEMENT_WINDOW_MS = 48 * 3600_000;

export interface SyncSummary {
  competitions: number;
  upserted: number;
  created: number;
  statusChanges: number;
  resultChanges: number;
  errors: { competition: string; error: string; httpStatus?: number }[];
}

@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name);
  constructor(private readonly dbs: DbService, @Inject(SPORTS_PROVIDER) private readonly provider: SportsProvider, private readonly bus: EventBus) {}

  get providerName() {
    return this.provider.name;
  }

  /** Upserts the competition catalogue; with the demo provider only the simulated leagues are enabled. */
  async syncCatalog() {
    const now = new Date();
    for (const c of CATALOG) {
      const enabled = this.provider.name === 'demo' ? DEMO_COMPETITIONS.includes(c.slug) : true;
      await this.dbs.db.insert(competitions).values({
        provider: this.provider.name, providerId: String(c.apiFootballId), slug: c.slug, name: c.name, country: c.country, countryCode: c.countryCode,
        region: c.region, type: c.type, priority: c.priority, enabled, bettingEnabled: true, coverageStatus: 'UNVERIFIED',
        seasonMode: c.seasonMode, currentSeason: seasonFor(c, now),
      }).onConflictDoUpdate({
        target: competitions.slug,
        set: { name: c.name, priority: c.priority, currentSeason: seasonFor(c, now), provider: this.provider.name, providerId: String(c.apiFootballId), updatedAt: now },
      });
    }
  }

  /** Coverage check: asks the provider which data it really has for each enabled competition. */
  async checkCoverage() {
    const comps = await this.dbs.db.select().from(competitions).where(eq(competitions.enabled, true));
    const out: { slug: string; status: string }[] = [];
    for (const c of comps) {
      try {
        const cov = this.provider.coverage ? await this.provider.coverage({ providerId: c.providerId, season: c.currentSeason!, slug: c.slug }) : null;
        const fx = await this.provider.fixtures({ providerId: c.providerId, season: c.currentSeason!, slug: c.slug }, new Date(Date.now() - 30 * DAY), new Date(Date.now() + 14 * DAY));
        const synthetic = !!(cov as any)?.synthetic;
        const status = synthetic ? 'UNVERIFIED' : cov && fx.length > 0 ? ((cov as any).fixtures?.events ? 'VERIFIED' : 'PARTIAL') : 'UNVERIFIED';
        await this.dbs.db.update(competitions).set({ coverage: { ...(cov ?? {}), fixturesFound: fx.length, checkedAt: new Date().toISOString() }, coverageStatus: status as any }).where(eq(competitions.id, c.id));
        out.push({ slug: c.slug, status });
      } catch (e: any) {
        out.push({ slug: c.slug, status: `ERROR: ${e.message}` });
      }
    }
    return out;
  }

  async syncFixtures(from = new Date(Date.now() - 2 * DAY), to = new Date(Date.now() + 8 * DAY), job = 'fixtures'): Promise<SyncSummary> {
    const [run] = await this.dbs.db.insert(providerSyncRuns).values({ provider: this.provider.name, job, status: 'RUNNING' }).returning();
    const summary: SyncSummary = { competitions: 0, upserted: 0, created: 0, statusChanges: 0, resultChanges: 0, errors: [] };
    const comps = await this.dbs.db.select().from(competitions).where(eq(competitions.enabled, true));
    for (const c of comps) {
      try {
        const list = await this.provider.fixtures({ providerId: c.providerId, season: c.currentSeason ?? from.getUTCFullYear(), slug: c.slug }, from, to);
        for (const f of list) await this.ingest(c.id, f, summary);
        summary.competitions++;
      } catch (e: any) {
        const httpStatus = e instanceof ProviderError ? e.httpStatus : undefined;
        summary.errors.push({ competition: c.slug, error: String(e?.message ?? e), httpStatus });
        this.log.warn(`sync ${c.slug} failed: ${e?.message}`);
      }
    }
    await this.dbs.db.update(providerSyncRuns).set({
      status: summary.errors.length === 0 ? 'SUCCESS' : summary.competitions > 0 ? 'PARTIAL' : 'FAILED',
      items: summary.upserted,
      error: summary.errors.length ? summary.errors.map((e) => `${e.competition}: ${e.error}`).join('; ').slice(0, 2000) : null,
      httpStatus: summary.errors[0]?.httpStatus ?? null,
      details: summary as any,
      finishedAt: new Date(),
    }).where(eq(providerSyncRuns.id, run.id));
    return summary;
  }

  /** Loads finished history (for rating fits) for every enabled competition. */
  async syncHistory(): Promise<SyncSummary> {
    const [run] = await this.dbs.db.insert(providerSyncRuns).values({ provider: this.provider.name, job: 'history', status: 'RUNNING' }).returning();
    const summary: SyncSummary = { competitions: 0, upserted: 0, created: 0, statusChanges: 0, resultChanges: 0, errors: [] };
    const comps = await this.dbs.db.select().from(competitions).where(eq(competitions.enabled, true));
    for (const c of comps) {
      try {
        const list = await this.provider.history({ providerId: c.providerId, season: c.currentSeason!, slug: c.slug });
        for (const f of list) await this.ingest(c.id, f, summary, 'history');
        summary.competitions++;
      } catch (e: any) {
        summary.errors.push({ competition: c.slug, error: String(e?.message ?? e), httpStatus: e?.httpStatus });
      }
    }
    await this.dbs.db.update(providerSyncRuns).set({ status: summary.errors.length ? 'PARTIAL' : 'SUCCESS', items: summary.upserted, finishedAt: new Date(), error: summary.errors.map((e) => e.error).join('; ').slice(0, 2000) || null }).where(eq(providerSyncRuns.id, run.id));
    return summary;
  }

  private async upsertTeam(tx: Database, t: ProviderTeam) {
    const [row] = await tx.insert(teams).values({ provider: this.provider.name, providerId: t.providerId, name: t.name, shortName: t.shortName, logoUrl: t.logoUrl ?? null, country: t.country ?? null })
      .onConflictDoUpdate({ target: [teams.provider, teams.providerId], set: { name: t.name, logoUrl: t.logoUrl ?? null } })
      .returning({ id: teams.id });
    return row.id;
  }

  /**
   * Idempotent ingestion of one provider fixture. De-duplication order:
   *   1. (source, external id) mapping;  2. same competition + teams + kick-off day (other source);
   *   3. insert new. Result changes bump result_version and are recorded in match_result_history.
   */
  async ingest(competitionId: string, f: ProviderFixture, summary?: SyncSummary, source = this.provider.name) {
    const event = await this.dbs.tx(async (tx) => {
      const homeId = await this.upsertTeam(tx, f.home);
      const awayId = await this.upsertTeam(tx, f.away);
      let [existing] = await tx.select().from(matches)
        .innerJoin(matchExternalIds, eq(matchExternalIds.matchId, matches.id))
        .where(and(eq(matchExternalIds.source, this.provider.name), eq(matchExternalIds.externalId, f.providerId)))
        .for('update', { of: matches })
        .then((r) => r.map((x) => x.matches));
      if (!existing) {
        [existing] = await tx.select().from(matches).where(and(
          eq(matches.competitionId, competitionId), eq(matches.homeTeamId, homeId), eq(matches.awayTeamId, awayId),
          gte(matches.originalKickoffAt, new Date(f.kickoffAt.getTime() - DAY)), lte(matches.originalKickoffAt, new Date(f.kickoffAt.getTime() + DAY)),
        )).for('update');
        if (existing) await tx.insert(matchExternalIds).values({ matchId: existing.id, source: this.provider.name, externalId: f.providerId }).onConflictDoNothing();
      }
      const hasResult = f.status === 'FINISHED' && f.homeGoals !== null && f.awayGoals !== null;
      if (!existing) {
        const [m] = await tx.insert(matches).values({
          provider: this.provider.name, providerId: f.providerId, competitionId, season: f.season, round: f.round ?? null,
          homeTeamId: homeId, awayTeamId: awayId, kickoffAt: f.kickoffAt, originalKickoffAt: f.kickoffAt,
          status: hasResult || f.status !== 'FINISHED' ? f.status : 'SUSPENDED', statusDetail: f.statusDetail ?? null,
          homeGoals: hasResult ? f.homeGoals : null, awayGoals: hasResult ? f.awayGoals : null,
          resultVersion: hasResult ? 1 : 0, resultSource: hasResult ? source : null, venue: f.venue ?? null, neutral: !!f.neutral, lastSyncedAt: new Date(),
        }).returning();
        await tx.insert(matchExternalIds).values({ matchId: m.id, source: this.provider.name, externalId: f.providerId }).onConflictDoNothing();
        if (hasResult) await tx.insert(matchResultHistory).values({ matchId: m.id, version: 1, status: 'FINISHED', homeGoals: f.homeGoals, awayGoals: f.awayGoals, source });
        if (summary) { summary.created++; summary.upserted++; }
        return null;
      }
      if (summary) summary.upserted++;
      return this.applyUpdate(tx, existing, f, source, summary);
    });
    if (event) {
      this.bus.emit({ type: 'match.updated', matchId: event.matchId, status: event.status });
      if (event.resultChanged) this.bus.emit({ type: 'match.result', matchId: event.matchId, resultVersion: event.resultVersion });
    }
  }

  private async applyUpdate(tx: Database, m: typeof matches.$inferSelect, f: ProviderFixture, source: string, summary?: SyncSummary) {
    if (m.resultLocked && f.status === 'FINISHED') {
      // result set manually by an operator (sandbox) — provider cannot overwrite it
      await tx.update(matches).set({ lastSyncedAt: new Date() }).where(eq(matches.id, m.id));
      return null;
    }
    let status: MatchStatus = f.status;
    const hasResult = f.status === 'FINISHED' && f.homeGoals !== null && f.awayGoals !== null;
    if (f.status === 'FINISHED' && !hasResult) status = 'SUSPENDED'; // finished without a score = inconsistent data
    const resultChanged = hasResult && (m.homeGoals !== f.homeGoals || m.awayGoals !== f.awayGoals || m.status !== 'FINISHED');
    const voidedNow = ['CANCELLED', 'ABANDONED'].includes(status) && m.status !== status;
    const kickoffChanged = f.kickoffAt.getTime() !== m.kickoffAt.getTime();
    const statusChanged = status !== m.status;
    if (!resultChanged && !voidedNow && !kickoffChanged && !statusChanged) {
      await tx.update(matches).set({ lastSyncedAt: new Date() }).where(eq(matches.id, m.id));
      return null;
    }
    let resultVersion = m.resultVersion;
    if (resultChanged || voidedNow) {
      resultVersion++;
      await tx.insert(matchResultHistory).values({ matchId: m.id, version: resultVersion, status, homeGoals: hasResult ? f.homeGoals : null, awayGoals: hasResult ? f.awayGoals : null, source });
      if (summary) summary.resultChanges++;
    }
    if (statusChanged && summary) summary.statusChanges++;
    await tx.update(matches).set({
      status,
      statusDetail: f.statusDetail ?? null,
      kickoffAt: f.kickoffAt,
      homeGoals: hasResult ? f.homeGoals : status === 'FINISHED' ? m.homeGoals : null,
      awayGoals: hasResult ? f.awayGoals : status === 'FINISHED' ? m.awayGoals : null,
      resultVersion,
      resultSource: resultChanged || voidedNow ? source : m.resultSource,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(matches.id, m.id));
    return { matchId: m.id, status, resultChanged: resultChanged || voidedNow || (kickoffChanged && Math.abs(f.kickoffAt.getTime() - m.originalKickoffAt.getTime()) > POSTPONEMENT_WINDOW_MS), resultVersion };
  }

  /** Pulls injuries/suspensions for matches kicking off in the next 48h (if the provider supports it). */
  async syncAvailability() {
    if (!this.provider.injuries) return 0;
    const upcoming = await this.dbs.db.select({ id: matches.id, home: matches.homeTeamId, away: matches.awayTeamId, ext: matchExternalIds.externalId })
      .from(matches).innerJoin(matchExternalIds, and(eq(matchExternalIds.matchId, matches.id), eq(matchExternalIds.source, this.provider.name)))
      .where(and(eq(matches.status, 'SCHEDULED'), gte(matches.kickoffAt, new Date()), lte(matches.kickoffAt, new Date(Date.now() + 2 * DAY))));
    let n = 0;
    for (const m of upcoming) {
      try {
        const inj = await this.provider.injuries(m.ext);
        const teamRows = await this.dbs.db.select().from(teams).where(inArray(teams.id, [m.home, m.away]));
        for (const t of teamRows) {
          const list = inj.filter((i) => i.teamProviderId === t.providerId);
          const missing = list.filter((i) => i.type === 'Missing Fixture').length + 0.5 * list.filter((i) => i.type === 'Questionable').length;
          // Heuristic until player-impact ratings are available: each absence ≈ 6% of contribution, capped at 50%.
          const loss = Math.min(0.5, 0.06 * missing).toFixed(3);
          await this.dbs.db.insert(teamAvailability).values({ matchId: m.id, teamId: t.id, attackLoss: loss, defenseLoss: loss, details: list as any })
            .onConflictDoUpdate({ target: [teamAvailability.matchId, teamAvailability.teamId], set: { attackLoss: loss, defenseLoss: loss, details: list as any, updatedAt: new Date() } });
          n++;
        }
      } catch (e: any) {
        this.log.warn(`injuries ${m.id}: ${e.message}`);
      }
    }
    return n;
  }

  /** Matches about to start whose data has not been refreshed recently. */
  async staleUpcoming(maxAgeMs = 6 * 3600_000) {
    return this.dbs.db.select({ id: matches.id }).from(matches).where(and(
      eq(matches.status, 'SCHEDULED'),
      lte(matches.kickoffAt, new Date(Date.now() + 3 * 3600_000)),
      sql`(${matches.lastSyncedAt} IS NULL OR ${matches.lastSyncedAt} < ${new Date(Date.now() - maxAgeMs)})`,
    ));
  }
}
