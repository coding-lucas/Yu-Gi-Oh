/**
 * Deterministic synthetic football data (SANDBOX ONLY): a fixed calendar of double round-robin
 * leagues anchored in time, results sampled from hidden ground-truth strengths after kick-off.
 * Shared by the API's DemoProvider and the static (GitHub Pages) demo build of the web app.
 */
import { hashSeed, rng } from './random';
import { sampleScore } from './simulate';

export interface DemoTeam {
  providerId: string;
  name: string;
  shortName: string;
  country: string;
  primaryColor?: string;
  secondaryColor?: string;
  crestPattern?: CrestPattern;
}
export interface DemoFixture {
  providerId: string;
  season: number;
  round: string;
  kickoffAt: Date;
  status: 'SCHEDULED' | 'LIVE' | 'FINISHED' | 'CANCELLED';
  statusDetail: string | null;
  home: DemoTeam;
  away: DemoTeam;
  homeGoals: number | null;
  awayGoals: number | null;
  venue: null;
  neutral: boolean;
}

/**
 * Club colours (factual, public information) used to render AthosBet's generated crest when no
 * licensed logo is available. This deliberately does NOT reproduce any club's registered crest:
 * official crests are trademarks and are displayed only from a licensed source (the data feed's
 * logo, e.g. API-Football, or an asset uploaded by an operator holding the rights).
 * [primary, secondary, pattern]
 */
export type CrestPattern = 'solid' | 'stripes' | 'hoops' | 'sash' | 'halves';
export const CLUB_COLORS: Record<string, [string, string, CrestPattern]> = {
  // Brasileirão Série A
  Flamengo: ['#C8102E', '#111111', 'hoops'], Palmeiras: ['#006437', '#FFFFFF', 'solid'], Botafogo: ['#111111', '#FFFFFF', 'stripes'],
  'São Paulo': ['#FFFFFF', '#D50000', 'hoops'], Corinthians: ['#FFFFFF', '#111111', 'solid'], Fluminense: ['#7A1E3A', '#00613C', 'stripes'],
  Internacional: ['#D50000', '#FFFFFF', 'solid'], 'Grêmio': ['#0D80BF', '#111111', 'stripes'], 'Atlético Mineiro': ['#111111', '#FFFFFF', 'stripes'],
  Cruzeiro: ['#003DA5', '#FFFFFF', 'solid'], Bahia: ['#0055A4', '#D50000', 'halves'], 'Vasco da Gama': ['#111111', '#FFFFFF', 'sash'],
  Fortaleza: ['#0B4EA2', '#D50000', 'hoops'], 'Red Bull Bragantino': ['#FFFFFF', '#D50000', 'solid'], Santos: ['#FFFFFF', '#111111', 'solid'],
  'Athletico Paranaense': ['#C8102E', '#111111', 'stripes'], 'Vitória': ['#D50000', '#111111', 'hoops'], Mirassol: ['#F6D600', '#00843D', 'solid'],
  'Ceará': ['#111111', '#FFFFFF', 'stripes'], 'Sport Recife': ['#D50000', '#111111', 'hoops'],
  // Série B
  Coritiba: ['#00544D', '#FFFFFF', 'hoops'], 'Goiás': ['#00843D', '#FFFFFF', 'solid'], Novorizontino: ['#F6D600', '#111111', 'solid'],
  'América Mineiro': ['#00843D', '#111111', 'solid'], Chapecoense: ['#00843D', '#FFFFFF', 'solid'], 'Criciúma': ['#F6D600', '#111111', 'stripes'],
  'Avaí': ['#0055A4', '#FFFFFF', 'stripes'], 'Cuiabá': ['#00843D', '#F6D600', 'halves'], Paysandu: ['#5BB4E5', '#FFFFFF', 'stripes'],
  'Operário': ['#111111', '#FFFFFF', 'stripes'], CRB: ['#D50000', '#FFFFFF', 'stripes'], 'Botafogo-SP': ['#D50000', '#111111', 'stripes'],
  'Atlético Goianiense': ['#D50000', '#111111', 'stripes'], 'Vila Nova': ['#D50000', '#FFFFFF', 'solid'], Remo: ['#0B2A5B', '#FFFFFF', 'solid'],
  'Ferroviária': ['#7A1E3A', '#FFFFFF', 'solid'], Amazonas: ['#F6D600', '#111111', 'stripes'], 'Volta Redonda': ['#F6D600', '#111111', 'stripes'],
  'Athletic Club': ['#111111', '#FFFFFF', 'stripes'], Juventude: ['#00843D', '#FFFFFF', 'stripes'],
  // Premier League
  Arsenal: ['#EF0107', '#FFFFFF', 'solid'], 'Manchester City': ['#6CABDD', '#FFFFFF', 'solid'], Liverpool: ['#C8102E', '#FFFFFF', 'solid'],
  Chelsea: ['#034694', '#FFFFFF', 'solid'], 'Tottenham Hotspur': ['#FFFFFF', '#132257', 'solid'], 'Manchester United': ['#DA291C', '#111111', 'solid'],
  'Newcastle United': ['#111111', '#FFFFFF', 'stripes'], 'Aston Villa': ['#670E36', '#95BFE5', 'halves'], Brighton: ['#0057B8', '#FFFFFF', 'stripes'],
  'West Ham United': ['#7A263A', '#1BB1E7', 'halves'], 'Crystal Palace': ['#1B458F', '#C4122E', 'halves'], Brentford: ['#E30613', '#FFFFFF', 'stripes'],
  Fulham: ['#FFFFFF', '#111111', 'solid'], Wolverhampton: ['#FDB913', '#231F20', 'solid'], Everton: ['#003399', '#FFFFFF', 'solid'],
  Bournemouth: ['#DA291C', '#111111', 'stripes'], 'Nottingham Forest': ['#DD0000', '#FFFFFF', 'solid'], 'Leeds United': ['#FFFFFF', '#1D428A', 'solid'],
  Burnley: ['#6C1D45', '#99D6EA', 'halves'], Sunderland: ['#EB172B', '#FFFFFF', 'stripes'],
  // La Liga
  'Real Madrid': ['#FFFFFF', '#FEBE10', 'solid'], Barcelona: ['#004D98', '#A50044', 'stripes'], 'Atlético Madrid': ['#CB3524', '#FFFFFF', 'stripes'],
  'Athletic Bilbao': ['#EE2523', '#FFFFFF', 'stripes'], 'Real Sociedad': ['#0067B1', '#FFFFFF', 'stripes'], Villarreal: ['#FFE667', '#005187', 'solid'],
  'Real Betis': ['#00954C', '#FFFFFF', 'stripes'], Sevilla: ['#FFFFFF', '#D71920', 'solid'], Valencia: ['#FFFFFF', '#111111', 'solid'],
  Girona: ['#CD2534', '#FFFFFF', 'stripes'], 'Celta Vigo': ['#8AC3EE', '#FFFFFF', 'solid'], Osasuna: ['#D91A21', '#0A346F', 'solid'],
  Getafe: ['#005999', '#FFFFFF', 'solid'], 'Rayo Vallecano': ['#FFFFFF', '#E53027', 'sash'], Mallorca: ['#E20613', '#111111', 'solid'],
  'Alavés': ['#0761AF', '#FFFFFF', 'stripes'], Espanyol: ['#007FC8', '#FFFFFF', 'stripes'], Levante: ['#004D98', '#A50044', 'stripes'],
  Elche: ['#FFFFFF', '#05642C', 'hoops'], 'Real Oviedo': ['#0057A8', '#FFFFFF', 'solid'],
  // Serie A
  Inter: ['#0068A8', '#111111', 'stripes'], Napoli: ['#12A0D7', '#FFFFFF', 'solid'], Juventus: ['#111111', '#FFFFFF', 'stripes'],
  Milan: ['#FB090B', '#111111', 'stripes'], Atalanta: ['#1E71B8', '#111111', 'stripes'], Roma: ['#8E1F2F', '#F0BC42', 'solid'],
  Lazio: ['#87D8F7', '#FFFFFF', 'solid'], Fiorentina: ['#482E92', '#FFFFFF', 'solid'], Bologna: ['#A21C26', '#1A2F48', 'stripes'],
  Torino: ['#8A1E03', '#FFFFFF', 'solid'], Udinese: ['#111111', '#FFFFFF', 'stripes'], Genoa: ['#AD0A26', '#002D62', 'halves'],
  Como: ['#003DA5', '#FFFFFF', 'solid'], Cagliari: ['#A6192E', '#002D62', 'halves'], Lecce: ['#F6D600', '#D50000', 'stripes'],
  Parma: ['#FFD200', '#003DA5', 'solid'], Verona: ['#FFD200', '#003DA5', 'solid'], Sassuolo: ['#00A752', '#111111', 'stripes'],
  Cremonese: ['#C8102E', '#9EA2A2', 'stripes'], Pisa: ['#111111', '#0055A4', 'stripes'],
  // Bundesliga
  'Bayern München': ['#DC052D', '#FFFFFF', 'solid'], 'Bayer Leverkusen': ['#E32221', '#111111', 'solid'], 'Borussia Dortmund': ['#FDE100', '#111111', 'solid'],
  'RB Leipzig': ['#FFFFFF', '#DD0741', 'solid'], 'Eintracht Frankfurt': ['#111111', '#E1000F', 'solid'], 'VfB Stuttgart': ['#FFFFFF', '#E32219', 'hoops'],
  'SC Freiburg': ['#D50000', '#111111', 'solid'], 'Borussia Mönchengladbach': ['#FFFFFF', '#111111', 'solid'], Wolfsburg: ['#65B32E', '#FFFFFF', 'solid'],
  'Mainz 05': ['#C3141E', '#FFFFFF', 'solid'], 'Werder Bremen': ['#1D9053', '#FFFFFF', 'solid'], 'Union Berlin': ['#EB1923', '#FFFFFF', 'solid'],
  Augsburg: ['#BA3733', '#46714D', 'halves'], Hoffenheim: ['#1961B5', '#FFFFFF', 'solid'], Heidenheim: ['#E30613', '#003B79', 'halves'],
  'St. Pauli': ['#5A3825', '#FFFFFF', 'solid'], 'Hamburger SV': ['#FFFFFF', '#0A3F86', 'solid'], '1. FC Köln': ['#FFFFFF', '#ED1C24', 'solid'],
  // UEFA / CONMEBOL extras
  'Paris Saint-Germain': ['#004170', '#DA291C', 'solid'], Benfica: ['#E83030', '#FFFFFF', 'solid'], Porto: ['#00428C', '#FFFFFF', 'stripes'], PSV: ['#ED1C24', '#FFFFFF', 'stripes'],
  'River Plate': ['#FFFFFF', '#EB192E', 'sash'], 'Boca Juniors': ['#103F79', '#F3B229', 'hoops'], 'Racing Club': ['#6CB4E4', '#FFFFFF', 'stripes'],
  Estudiantes: ['#D50000', '#FFFFFF', 'stripes'], 'Peñarol': ['#FFD200', '#111111', 'stripes'], Nacional: ['#FFFFFF', '#00205B', 'solid'],
  'Colo-Colo': ['#FFFFFF', '#111111', 'solid'], 'Atlético Nacional': ['#00843D', '#FFFFFF', 'stripes'], 'LDU Quito': ['#FFFFFF', '#C8102E', 'solid'],
  Universitario: ['#F2E8C9', '#7A1E3A', 'solid'],
};

export function shortName(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} -]/gu, '').split(/[ -]/).filter(Boolean);
  if (words.length === 1) return name.slice(0, 3).toUpperCase();
  const sig = words.filter((w) => !/^\d+$/.test(w) && (w.length > 2 || /^[A-Z]+$/.test(w)));
  return (sig.length >= 2 ? sig.map((w) => (/^[A-Z]+$/.test(w) ? w : w[0])).join('') : words[0].slice(0, 3)).slice(0, 3).toUpperCase();
}

function demoTeam(name: string, country: string): DemoTeam {
  const c = CLUB_COLORS[name];
  return { providerId: `demo:${name}`, name, shortName: shortName(name), country, ...(c ? { primaryColor: c[0], secondaryColor: c[1], crestPattern: c[2] } : {}) };
}

export const DEMO_LEAGUES: Record<string, { teams: string[]; days: number[]; hoursUtc: number[]; country: string }> = {
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

export const DEMO_ANCHOR = Date.UTC(2025, 0, 6); // Monday
const DAY = 86_400_000;

export const DEMO_COMPETITIONS = Object.keys(DEMO_LEAGUES);

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

export function demoFixtures(slug: string, until: Date, now: Date = new Date(), simulateResults = true): DemoFixture[] {
  const L = DEMO_LEAGUES[slug];
  if (!L) return [];
  const n = L.teams.length;
  const out: DemoFixture[] = [];
  const nowMs = now.getTime();
  const sorted = [...L.days].sort((a, b) => a - b);
  let round = 0;
  for (let week = 0; ; week++) {
    for (const dow of sorted) {
      const dayStart = DEMO_ANCHOR + week * 7 * DAY + ((dow + 6) % 7) * DAY;
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
        let status: DemoFixture['status'] = 'SCHEDULED';
        let hg: number | null = null, ag: number | null = null;
        const elapsed = nowMs - kickoff.getTime();
        if (cancelled && elapsed > -2 * DAY) status = 'CANCELLED';
        else if (elapsed > 2 * 3600_000 && simulateResults) {
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
