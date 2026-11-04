import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt, sql, SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DbService } from '../db/db.service';
import { competitions, favorites, markets, matches, odds, probabilitySnapshots, teams } from '../db/schema';
import { addDaysYmd, isValidTz, localDayRange, localYmd } from '../common/time';
import { err } from '../common/errors';
import { PricingService } from '../odds/pricing.service';

export type MatchFilter = 'today' | 'tomorrow' | 'week' | 'live' | 'date';

const REGION_ORDER = ['BRAZIL', 'SOUTH_AMERICA', 'EUROPE', 'WORLD', 'OTHER'];

@Injectable()
export class SportsService {
  constructor(private readonly dbs: DbService, private readonly pricing: PricingService) {}

  async competitions() {
    return this.dbs.db.select({
      id: competitions.id, slug: competitions.slug, name: competitions.name, country: competitions.country, countryCode: competitions.countryCode,
      region: competitions.region, type: competitions.type, priority: competitions.priority, bettingEnabled: competitions.bettingEnabled,
      coverageStatus: competitions.coverageStatus, logoUrl: competitions.logoUrl,
    }).from(competitions).where(eq(competitions.enabled, true)).orderBy(asc(competitions.priority));
  }

  async listMatches(q: { filter: MatchFilter; date?: string; tz: string; competition?: string; teamId?: string; favoritesOf?: string }) {
    const tz = isValidTz(q.tz) ? q.tz : 'UTC';
    const today = localYmd(new Date(), tz);
    const where: SQL[] = [eq(competitions.enabled, true)];
    if (q.filter === 'live') where.push(eq(matches.status, 'LIVE'));
    else {
      const [from, to] =
        q.filter === 'today' ? localDayRange(today, tz)
        : q.filter === 'tomorrow' ? localDayRange(addDaysYmd(today, 1), tz)
        : q.filter === 'week' ? localDayRange(today, tz, 7)
        : localDayRange(q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : today, tz);
      where.push(gte(matches.kickoffAt, from), lt(matches.kickoffAt, to));
    }
    if (q.competition) where.push(eq(competitions.slug, q.competition));
    if (q.teamId) where.push(sql`(${matches.homeTeamId} = ${q.teamId} OR ${matches.awayTeamId} = ${q.teamId})`);
    if (q.favoritesOf) {
      where.push(sql`(
        ${matches.competitionId} IN (SELECT ref_id FROM favorites WHERE user_id = ${q.favoritesOf} AND kind='COMPETITION')
        OR ${matches.homeTeamId} IN (SELECT ref_id FROM favorites WHERE user_id = ${q.favoritesOf} AND kind='TEAM')
        OR ${matches.awayTeamId} IN (SELECT ref_id FROM favorites WHERE user_id = ${q.favoritesOf} AND kind='TEAM'))`);
    }
    const rows = await this.baseQuery().where(and(...where)).orderBy(asc(competitions.priority), asc(matches.kickoffAt)).limit(600);
    const withOdds = await this.attachMainOdds(rows);
    // group by region → competition (Brazil first, independent of the user's location)
    const groups = new Map<string, { competition: (typeof withOdds)[number]['competition']; matches: typeof withOdds }>();
    for (const r of withOdds) {
      const g = groups.get(r.competition.id) ?? { competition: r.competition, matches: [] };
      g.matches.push(r);
      groups.set(r.competition.id, g);
    }
    const list = [...groups.values()].sort((a, b) => REGION_ORDER.indexOf(a.competition.region) - REGION_ORDER.indexOf(b.competition.region) || a.competition.priority - b.competition.priority);
    return { tz, today, filter: q.filter, groups: list, total: withOdds.length };
  }

  /** Highlighted fixtures: featured competitions, next 72h, most balanced / highest-profile first. */
  async featured(limit = 8) {
    const rows = await this.baseQuery().where(and(
      eq(competitions.enabled, true), eq(matches.status, 'SCHEDULED'), gte(matches.kickoffAt, new Date()), lt(matches.kickoffAt, new Date(Date.now() + 72 * 3600_000)),
    )).orderBy(asc(competitions.priority), asc(matches.kickoffAt)).limit(200);
    const withOdds = (await this.attachMainOdds(rows)).filter((r) => r.mainMarket?.status === 'OPEN');
    const score = (r: (typeof withOdds)[number]) => {
      const sel = r.mainMarket!.selections;
      const h = sel.find((s) => s.key === 'HOME')?.odds ?? 3, a = sel.find((s) => s.key === 'AWAY')?.odds ?? 3;
      return r.competition.priority * 0.5 + Math.abs(Math.log(h / a)) * 4 + (r.featured ? -20 : 0);
    };
    return withOdds.sort((a, b) => score(a) - score(b)).slice(0, limit);
  }

  private baseQuery() {
    const home = alias(teams, 'home');
    const away = alias(teams, 'away');
    return this.dbs.db.select({
      id: matches.id, kickoffAt: matches.kickoffAt, status: matches.status, statusDetail: matches.statusDetail, round: matches.round,
      homeGoals: matches.homeGoals, awayGoals: matches.awayGoals, featured: matches.featured, provider: matches.provider,
      home: { id: home.id, name: home.name, shortName: home.shortName, logoUrl: home.logoUrl, primaryColor: home.primaryColor, secondaryColor: home.secondaryColor, crestPattern: home.crestPattern },
      away: { id: away.id, name: away.name, shortName: away.shortName, logoUrl: away.logoUrl, primaryColor: away.primaryColor, secondaryColor: away.secondaryColor, crestPattern: away.crestPattern },
      competition: { id: competitions.id, slug: competitions.slug, name: competitions.name, country: competitions.country, countryCode: competitions.countryCode, region: competitions.region, priority: competitions.priority },
    }).from(matches)
      .innerJoin(competitions, eq(competitions.id, matches.competitionId))
      .innerJoin(home, eq(home.id, matches.homeTeamId))
      .innerJoin(away, eq(away.id, matches.awayTeamId))
      .$dynamic();
  }

  private async attachMainOdds<T extends { id: string }>(rows: T[]) {
    if (!rows.length) return [] as (T & { mainMarket: null | { id: string; status: string; selections: { key: string; oddsId: number; odds: number; oddsK: number }[] }; marketCount: number })[];
    const mks = await this.dbs.db.select().from(markets).where(inArray(markets.matchId, rows.map((r) => r.id)));
    const main = mks.filter((m) => m.key === 'MATCH_RESULT');
    const cur = main.length ? await this.dbs.db.select().from(odds).where(and(inArray(odds.marketId, main.map((m) => m.id)), eq(odds.isCurrent, true))) : [];
    const order = ['HOME', 'DRAW', 'AWAY'];
    return rows.map((r) => {
      const mm = main.find((m) => m.matchId === r.id);
      return {
        ...r,
        marketCount: mks.filter((m) => m.matchId === r.id && m.status === 'OPEN').length,
        mainMarket: mm ? {
          id: mm.id, status: mm.status,
          selections: cur.filter((o) => o.marketId === mm.id).sort((a, b) => order.indexOf(a.selection) - order.indexOf(b.selection))
            .map((o) => ({ key: o.selection, oddsId: o.id, odds: o.oddsK / 1000, oddsK: o.oddsK })),
        } : null,
      };
    });
  }

  async match(id: string) {
    const [m] = await this.baseQuery().where(eq(matches.id, id));
    if (!m) throw err.notFound('MATCH_NOT_FOUND');
    const mk = await this.pricing.marketsFor(id);
    const [snap] = await this.dbs.db.select().from(probabilitySnapshots).where(eq(probabilitySnapshots.matchId, id)).orderBy(sql`${probabilitySnapshots.id} DESC`).limit(1);
    const form = async (teamId: string) => {
      const r = await this.dbs.db.select({ h: matches.homeTeamId, hg: matches.homeGoals, ag: matches.awayGoals, at: matches.kickoffAt }).from(matches)
        .where(and(eq(matches.status, 'FINISHED'), lt(matches.kickoffAt, m.kickoffAt), sql`(${matches.homeTeamId} = ${teamId} OR ${matches.awayTeamId} = ${teamId})`))
        .orderBy(sql`${matches.kickoffAt} DESC`).limit(5);
      return r.map((x) => {
        const gf = x.h === teamId ? x.hg! : x.ag!, ga = x.h === teamId ? x.ag! : x.hg!;
        return gf > ga ? 'W' : gf === ga ? 'D' : 'L';
      });
    };
    return {
      ...m,
      markets: mk,
      model: snap ? { version: snap.modelVersion, lambdaHome: snap.lambdaHome, lambdaAway: snap.lambdaAway, status: snap.status, suspensionReason: snap.suspensionReason, external: snap.external, at: snap.createdAt } : null,
      form: { home: await form(m.home.id), away: await form(m.away.id) },
    };
  }

  async toggleFavorite(userId: string, kind: 'TEAM' | 'COMPETITION', refId: string) {
    const del = await this.dbs.db.delete(favorites).where(and(eq(favorites.userId, userId), eq(favorites.kind, kind), eq(favorites.refId, refId))).returning();
    if (del.length) return { favorite: false };
    await this.dbs.db.insert(favorites).values({ userId, kind, refId });
    return { favorite: true };
  }

  async favorites(userId: string) {
    return this.dbs.db.select().from(favorites).where(eq(favorites.userId, userId));
  }
}
