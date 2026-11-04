import { ExternalOdds } from '@athosbet/odds-engine';

export interface OddsApiEvent {
  id: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: Date;
  consensus: ExternalOdds;
}

/**
 * The Odds API v4 client (price comparison only). Averages decimal odds across bookmakers for h2h
 * and the 2.5 totals line. Usage must respect the provider's commercial terms.
 */
export class OddsApiClient {
  constructor(private readonly key: string, private readonly baseUrl: string, private readonly http: typeof fetch = fetch) {}

  async events(sportKey: string): Promise<OddsApiEvent[]> {
    const url = new URL(`${this.baseUrl}/sports/${sportKey}/odds`);
    url.searchParams.set('apiKey', this.key);
    url.searchParams.set('regions', 'eu,uk');
    url.searchParams.set('markets', 'h2h,totals');
    url.searchParams.set('oddsFormat', 'decimal');
    const res = await this.http(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`The Odds API HTTP ${res.status}`);
    const body = (await res.json()) as any[];
    return body.map((e) => OddsApiClient.parse(e));
  }

  static parse(e: any): OddsApiEvent {
    const h: number[] = [], d: number[] = [], a: number[] = [], o: number[] = [], u: number[] = [];
    for (const b of e.bookmakers ?? []) {
      for (const m of b.markets ?? []) {
        if (m.key === 'h2h') {
          for (const x of m.outcomes) {
            if (x.name === e.home_team) h.push(x.price);
            else if (x.name === e.away_team) a.push(x.price);
            else if (x.name === 'Draw') d.push(x.price);
          }
        } else if (m.key === 'totals') {
          for (const x of m.outcomes) if (x.point === 2.5) (x.name === 'Over' ? o : u).push(x.price);
        }
      }
    }
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const consensus: ExternalOdds = { bookmakers: (e.bookmakers ?? []).length };
    if (h.length && d.length && a.length) consensus.matchResult = { home: avg(h), draw: avg(d), away: avg(a) };
    if (o.length && u.length) consensus.totals25 = { over: avg(o), under: avg(u) };
    return { id: e.id, homeTeam: e.home_team, awayTeam: e.away_team, commenceTime: new Date(e.commence_time), consensus };
  }
}

/** Name normalisation used to match external events to our fixtures. */
export function normalizeTeamName(n: string): string {
  return n
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|sc|ac|afc|cd|ec|se|cr|ca|club|de|futebol|fk|sk)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}
