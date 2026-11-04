import type { MatchStatus } from '../../db/schema';
import { CompetitionRef, ProviderError, ProviderFixture, ProviderInjury, SportsProvider } from './types';

/** Mapping of API-Football fixture.status.short to AthosBet statuses. */
export function mapApiFootballStatus(short: string): MatchStatus {
  switch (short) {
    case 'TBD': case 'NS': return 'SCHEDULED';
    case '1H': case 'HT': case '2H': case 'ET': case 'BT': case 'P': case 'LIVE': return 'LIVE';
    case 'SUSP': case 'INT': return 'SUSPENDED';
    case 'FT': case 'AET': case 'PEN': return 'FINISHED';
    case 'PST': return 'POSTPONED';
    case 'CANC': return 'CANCELLED';
    case 'ABD': return 'ABANDONED';
    // Awarded / walkover: the official sporting result was not decided on the pitch -> void.
    case 'AWD': case 'WO': return 'CANCELLED';
    default: return 'SUSPENDED';
  }
}

type Fetch = typeof fetch;

/**
 * API-Football v3 (api-sports.io) client. Uses `score.fulltime` (90') for settlement so that extra
 * time / penalties never leak into regular-time markets.
 */
export class ApiFootballProvider implements SportsProvider {
  readonly name = 'api-football';
  constructor(private readonly key: string, private readonly baseUrl: string, private readonly http: Fetch = fetch, private readonly timeoutMs = 15_000) {}

  private async get(path: string, params: Record<string, string | number>): Promise<any[]> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await this.http(url, { headers: { 'x-apisports-key': this.key }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e: any) {
      throw new ProviderError(`network error: ${e?.message ?? e}`);
    }
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, res.status, res.status >= 500 || res.status === 429);
    const body: any = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.response)) throw new ProviderError('malformed response', res.status, false);
    const errors = body.errors && (Array.isArray(body.errors) ? body.errors : Object.values(body.errors));
    if (errors && errors.length) throw new ProviderError(`provider error: ${JSON.stringify(body.errors)}`, res.status, false);
    return body.response;
  }

  static toFixture(r: any): ProviderFixture {
    const status = mapApiFootballStatus(r.fixture?.status?.short ?? '');
    const ft = r.score?.fulltime ?? {};
    const finished = status === 'FINISHED';
    return {
      providerId: String(r.fixture.id),
      season: Number(r.league?.season),
      round: r.league?.round ?? null,
      kickoffAt: new Date(r.fixture.date),
      status,
      statusDetail: r.fixture?.status?.long ?? null,
      home: { providerId: String(r.teams.home.id), name: r.teams.home.name, logoUrl: r.teams.home.logo ?? null },
      away: { providerId: String(r.teams.away.id), name: r.teams.away.name, logoUrl: r.teams.away.logo ?? null },
      homeGoals: finished ? numOrNull(ft.home ?? r.goals?.home) : null,
      awayGoals: finished ? numOrNull(ft.away ?? r.goals?.away) : null,
      venue: r.fixture?.venue?.name ?? null,
    };
  }

  async fixtures(comp: CompetitionRef, from: Date, to: Date) {
    const rows = await this.get('/fixtures', { league: comp.providerId, season: comp.season, from: ymd(from), to: ymd(to), timezone: 'UTC' });
    return rows.map(ApiFootballProvider.toFixture);
  }

  async history(comp: CompetitionRef) {
    const out: ProviderFixture[] = [];
    for (const season of [comp.season - 1, comp.season]) {
      const rows = await this.get('/fixtures', { league: comp.providerId, season, status: 'FT-AET-PEN' });
      out.push(...rows.map(ApiFootballProvider.toFixture));
    }
    return out;
  }

  async injuries(fixtureProviderId: string): Promise<ProviderInjury[]> {
    const rows = await this.get('/injuries', { fixture: fixtureProviderId });
    return rows.map((r) => ({ teamProviderId: String(r.team?.id), player: r.player?.name, type: r.player?.type, reason: r.player?.reason }));
  }

  async coverage(comp: CompetitionRef) {
    const rows = await this.get('/leagues', { id: comp.providerId, season: comp.season });
    const season = rows[0]?.seasons?.find((s: any) => s.year === comp.season);
    return season?.coverage ?? null;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}
function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}
