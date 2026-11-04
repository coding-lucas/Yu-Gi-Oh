import { DEMO_COMPETITIONS as COMPS, DEMO_LEAGUES, demoFixtures, shortName as sn } from '@athosbet/odds-engine';
import { CompetitionRef, ProviderFixture, SportsProvider } from './types';

/**
 * Deterministic SANDBOX data provider used when no API-Football key is configured. The generator
 * lives in @athosbet/odds-engine (demo-league.ts) so the static web demo uses the exact same data.
 * All data produced here is SYNTHETIC and labelled as such.
 */
export const LEAGUES = DEMO_LEAGUES;
export const DEMO_COMPETITIONS = COMPS;
export const shortName = sn;
const DAY = 86_400_000;

export class DemoProvider implements SportsProvider {
  readonly name = 'demo';
  constructor(private readonly simulateResults = true, private readonly now: () => Date = () => new Date()) {}

  private all(slug: string, until: Date): ProviderFixture[] {
    return demoFixtures(slug, until, this.now(), this.simulateResults) as ProviderFixture[];
  }

  async fixtures(comp: CompetitionRef, from: Date, to: Date) {
    return this.all(comp.slug, to).filter((f) => f.kickoffAt >= from && f.kickoffAt <= to);
  }

  async history(comp: CompetitionRef) {
    const now = this.now();
    return this.all(comp.slug, now).filter((f) => f.status === 'FINISHED' && f.kickoffAt.getTime() > now.getTime() - 500 * DAY);
  }

  async injuries() {
    return [];
  }

  async coverage() {
    return { fixtures: { events: false, statistics_fixtures: false }, standings: false, injuries: false, odds: false, synthetic: true };
  }
}
