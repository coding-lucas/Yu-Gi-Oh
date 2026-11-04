import { hashSeed, rng, sampleScore } from '@athosbet/odds-engine';
import { CompetitionRef, ProviderFixture, ProviderTeam, SportsProvider } from './types';
import { CLUB_COLORS } from './club-colors';

export function shortName(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} -]/gu, '').split(/[ -]/).filter(Boolean);
  if (words.length === 1) return name.slice(0, 3).toUpperCase();
  const sig = words.filter((w) => !/^\d+$/.test(w) && (w.length > 2 || /^[A-Z]+$/.test(w)));
  return (sig.length >= 2 ? sig.map((w) => (/^[A-Z]+$/.test(w) ? w : w[0])).join('') : words[0].slice(0, 3)).slice(0, 3).toUpperCase();
}

function demoTeam(name: string, country: string): ProviderTeam {
  const c = CLUB_COLORS[name];
  return { providerId: `demo:${name}`, name, shortName: shortName(name), country, ...(c ? { primaryColor: c[0], secondaryColor: c[1], crestPattern: c[2] } : {}) };
}

/**
 * Deterministic SANDBOX data provider used when no API-Football key is configured. Fixtures follow
 * a fixed calendar (double round-robin, circle method) anchored in time, so every sync returns the
 * same fixtures; matches whose kick-off is >2h in the past are "played" with scores sampled from a
 * hidden ground-truth strength model. All data produced here is SYNTHETIC and labelled as such.
 */
export const LEAGUES: Record<string, { teams: string[]; days: number[]; hoursUtc: number[]; country: string }> = {
  'brasileirao-serie-a': {
    country: 'Brazil', days: [0, 3, 6], hoursUtc: [19, 21.5, 23.5, 0.5],
    teams: ['Flamengo', 'Palmeiras', 'Botafogo', 'São Paulo', 'Corinthians', 'Fluminense', 'Internacional', 'Grêmio', 'Atlético Mineiro', 'Cruzeiro', 'Bahia', 'Vasco da Gama', 'Fortaleza', 'Red Bull Bragantino', 'Santos', 'Athletico Paranaense', 'Vitória', 'Mirassol', 'Ceará', 'Sport Recife'],
  },
  'brasileirao-serie-b': {
    country: 'Brazil', days: [1, 5], hoursUtc: [22, 23.5],
    teams: ['Coritiba', 'Goiás', 'Novorizontino', 'América Mineiro', 'Chapecoense', 'Criciúma', 'Avaí', 'Cuiabá', 'Paysandu', 'Operário', 'CRB', 'Botafogo-SP', 'Atlético Goianiense', 'Vila Nova', 'Remo', 'Ferroviária', 'Amazonas', 'Volta Redonda', 'Athletic Club', 'Juventude'],
  },
  'premier-league': {
    country: 'England', days: [6, 0], hoursUtc: [12.5, 15, 17.5],
    teams: ['Arsenal', 'Manchester City', 'Liverpool', 'Chelsea', 'Tottenham Hotspur', 'Manchester United', 'Newcastle United', 'Aston Villa', 'Brighton', 'West Ham United', 'Crystal Palace', 'Brentford', 'Fulham', 'Wolverhampton', 'Everton', 'Bournemouth', 'Nottingham Forest', 'Leeds United', 'Burnley', 'Sunderland'],
  },
  'la-liga': {
    country: 'Spain', days: [6, 0], hoursUtc: [14, 16.5, 19, 20],
    teams: ['Real Madrid', 'Barcelona', 'Atlético Madrid', 'Athletic Bilbao', 'Real Sociedad', 'Villarreal', 'Real Betis', 'Sevilla', 'Valencia', 'Girona', 'Celta Vigo', 'Osasuna', 'Getafe', 'Rayo Vallecano', 'Mallorca', 'Alavés', 'Espanyol', 'Levante', 'Elche', 'Real Oviedo'],
  },
  'serie-a-italia': {
    country: 'Italy', days: [6, 0], hoursUtc: [14, 17, 19.75],
    teams: ['Inter', 'Napoli', 'Juventus', 'Milan', 'Atalanta', 'Roma', 'Lazio', 'Fiorentina', 'Bologna', 'Torino', 'Udinese', 'Genoa', 'Como', 'Cagliari', 'Lecce', 'Parma', 'Verona', 'Sassuolo', 'Cremonese', 'Pisa'],
  },
  bundesliga: {
    country: 'Germany', days: [6, 0], hoursUtc: [14.5, 17.5],
    teams: ['Bayern München', 'Bayer Leverkusen', 'Borussia Dortmund', 'RB Leipzig', 'Eintracht Frankfurt', 'VfB Stuttgart', 'SC Freiburg', 'Borussia Mönchengladbach', 'Wolfsburg', 'Mainz 05', 'Werder Bremen', 'Union Berlin', 'Augsburg', 'Hoffenheim', 'Heidenheim', 'St. Pauli', 'Hamburger SV', '1. FC Köln'],
  },
  'uefa-champions-league': {
    country: 'Europe', days: [2, 3], hoursUtc: [17.75, 20],
    teams: ['Real Madrid', 'Barcelona', 'Bayern München', 'Manchester City', 'Arsenal', 'Liverpool', 'Inter', 'Paris Saint-Germain', 'Bayer Leverkusen', 'Borussia Dortmund', 'Atlético Madrid', 'Juventus', 'Napoli', 'Benfica', 'Porto', 'PSV'],
  },
  libertadores: {
    country: 'South America', days: [2, 4], hoursUtc: [22, 0.5],
    teams: ['Flamengo', 'Palmeiras', 'River Plate', 'Boca Juniors', 'Botafogo', 'Racing Club', 'Estudiantes', 'Peñarol', 'Nacional', 'Colo-Colo', 'Atlético Nacional', 'LDU Quito', 'Internacional', 'São Paulo', 'Fortaleza', 'Universitario'],
  },
};

const ANCHOR = Date.UTC(2025, 0, 6); // Monday
const DAY = 86_400_000;

export const DEMO_COMPETITIONS = Object.keys(LEAGUES);

function strength(slug: string, team: string, idx: number, n: number) {
  // tiered ground truth: earlier listed teams are stronger, plus deterministic noise
  const r = rng(hashSeed(`${slug}:${team}`));
  const tier = 0.45 - (0.9 * idx) / Math.max(1, n - 1);
  return { attack: tier * 0.8 + (r() - 0.5) * 0.25, defense: tier * 0.7 + (r() - 0.5) * 0.25 };
}

function roundRobin(n: number, round: number): [number, number][] {
  // circle method; second half of the season mirrors home/away
  const teams = Array.from({ length: n }, (_, i) => i);
  const rounds = n - 1;
  const r = round % (2 * rounds);
  const rr = r % rounds;
  const arr = [teams[0], ...teams.slice(1).slice(rr).concat(teams.slice(1).slice(0, rr))];
  const pairs: [number, number][] = [];
  for (let i = 0; i < n / 2; i++) {
    let h = arr[i], a = arr[n - 1 - i];
    if ((rr + i) % 2 === 1) [h, a] = [a, h];
    if (r >= rounds) [h, a] = [a, h];
    pairs.push([h, a]);
  }
  return pairs;
}

export class DemoProvider implements SportsProvider {
  readonly name = 'demo';
  constructor(private readonly simulateResults = true, private readonly now: () => Date = () => new Date()) {}

  private allFixtures(slug: string, until: Date): ProviderFixture[] {
    const L = LEAGUES[slug];
    if (!L) return [];
    const n = L.teams.length;
    const out: ProviderFixture[] = [];
    const nowMs = this.now().getTime();
    const sorted = [...L.days].sort((a, b) => a - b);
    let round = 0;
    for (let week = 0; ; week++) {
      for (const dow of sorted) {
        const dayStart = ANCHOR + week * 7 * DAY + ((dow + 6) % 7) * DAY;
        if (dayStart > until.getTime()) return out;
        const pairs = roundRobin(n, round);
        pairs.forEach(([h, a], i) => {
          const hour = L.hoursUtc[i % L.hoursUtc.length];
          const kickoff = new Date(dayStart + hour * 3600_000);
          const home = L.teams[h], away = L.teams[a];
          const pid = `${slug}:${round}:${h}-${a}`;
          const seed = hashSeed(pid);
          const r = rng(seed);
          const cancelled = r() < 1 / 120;
          let status: ProviderFixture['status'] = 'SCHEDULED';
          let hg: number | null = null, ag: number | null = null;
          const elapsed = nowMs - kickoff.getTime();
          if (cancelled && elapsed > -2 * DAY) status = 'CANCELLED';
          else if (elapsed > 2 * 3600_000 && this.simulateResults) {
            const sh = strength(slug, home, h, n), sa = strength(slug, away, a, n);
            const lh = Math.exp(0.28 + 0.22 + sh.attack - sa.defense);
            const la = Math.exp(0.28 + sa.attack - sh.defense);
            [hg, ag] = sampleScore(lh, la, -0.06, r);
            status = 'FINISHED';
          } else if (elapsed > 0 && elapsed <= 2 * 3600_000) status = 'LIVE';
          const season = new Date(dayStart).getUTCFullYear();
          out.push({
            providerId: pid, season, round: `Round ${(round % (2 * (n - 1))) + 1}`, kickoffAt: kickoff, status,
            statusDetail: status === 'CANCELLED' ? 'Cancelled (sandbox simulation)' : null,
            home: demoTeam(home, L.country),
            away: demoTeam(away, L.country),
            homeGoals: hg, awayGoals: ag, venue: null, neutral: false,
          });
        });
        round++;
      }
    }
  }

  async fixtures(comp: CompetitionRef, from: Date, to: Date) {
    return this.allFixtures(comp.slug, to).filter((f) => f.kickoffAt >= from && f.kickoffAt <= to);
  }

  async history(comp: CompetitionRef) {
    const now = this.now();
    return this.allFixtures(comp.slug, now).filter((f) => f.status === 'FINISHED' && f.kickoffAt.getTime() > now.getTime() - 500 * DAY);
  }

  async injuries() {
    return [];
  }

  async coverage() {
    return { fixtures: { events: false, statistics_fixtures: false }, standings: false, injuries: false, odds: false, synthetic: true };
  }
}
