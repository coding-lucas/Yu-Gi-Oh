/**
 * Competition catalogue. IDs refer to API-Football (api-sports.io v3) league ids and The Odds API
 * sport keys. Every entry starts as coverage UNVERIFIED: a competition is only considered
 * integrated after `coverage-check` confirms fixtures/scores coverage with real data (see PROGRESS.md).
 * Adding a competition = adding an entry here (no structural change).
 */
export interface CatalogCompetition {
  slug: string;
  name: string;
  country: string;
  countryCode: string | null;
  region: 'BRAZIL' | 'SOUTH_AMERICA' | 'EUROPE' | 'WORLD' | 'OTHER';
  type: 'LEAGUE' | 'CUP' | 'INTERNATIONAL';
  apiFootballId: number;
  oddsApiKey?: string;
  seasonMode: 'CALENDAR' | 'SPLIT'; // CALENDAR: season = year; SPLIT: season = start year (Aug–May)
  priority: number; // lower = shown first
  featured?: boolean;
}

export const CATALOG: CatalogCompetition[] = [
  // ── Brasil (priority) ──
  { slug: 'brasileirao-serie-a', name: 'Brasileirão Série A', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', type: 'LEAGUE', apiFootballId: 71, oddsApiKey: 'soccer_brazil_campeonato', seasonMode: 'CALENDAR', priority: 1, featured: true },
  { slug: 'brasileirao-serie-b', name: 'Brasileirão Série B', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', type: 'LEAGUE', apiFootballId: 72, oddsApiKey: 'soccer_brazil_serie_b', seasonMode: 'CALENDAR', priority: 2 },
  { slug: 'copa-do-brasil', name: 'Copa do Brasil', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', type: 'CUP', apiFootballId: 73, seasonMode: 'CALENDAR', priority: 3 },
  { slug: 'brasileirao-serie-c', name: 'Brasileirão Série C', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', type: 'LEAGUE', apiFootballId: 75, seasonMode: 'CALENDAR', priority: 4 },
  { slug: 'brasileirao-serie-d', name: 'Brasileirão Série D', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', type: 'LEAGUE', apiFootballId: 76, seasonMode: 'CALENDAR', priority: 5 },
  { slug: 'paulista', name: 'Paulistão', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', type: 'LEAGUE', apiFootballId: 475, seasonMode: 'CALENDAR', priority: 6 },
  { slug: 'carioca', name: 'Carioca', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', type: 'LEAGUE', apiFootballId: 624, seasonMode: 'CALENDAR', priority: 7 },
  { slug: 'mineiro', name: 'Mineiro', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', type: 'LEAGUE', apiFootballId: 629, seasonMode: 'CALENDAR', priority: 8 },
  { slug: 'gaucho', name: 'Gaúcho', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', type: 'LEAGUE', apiFootballId: 477, seasonMode: 'CALENDAR', priority: 9 },
  // ── América do Sul ──
  { slug: 'libertadores', name: 'CONMEBOL Libertadores', country: 'South America', countryCode: null, region: 'SOUTH_AMERICA', type: 'INTERNATIONAL', apiFootballId: 13, oddsApiKey: 'soccer_conmebol_copa_libertadores', seasonMode: 'CALENDAR', priority: 10, featured: true },
  { slug: 'sudamericana', name: 'CONMEBOL Sudamericana', country: 'South America', countryCode: null, region: 'SOUTH_AMERICA', type: 'INTERNATIONAL', apiFootballId: 11, oddsApiKey: 'soccer_conmebol_copa_sudamericana', seasonMode: 'CALENDAR', priority: 11 },
  { slug: 'argentina-liga-profesional', name: 'Liga Profesional Argentina', country: 'Argentina', countryCode: 'AR', region: 'SOUTH_AMERICA', type: 'LEAGUE', apiFootballId: 128, oddsApiKey: 'soccer_argentina_primera_division', seasonMode: 'CALENDAR', priority: 12 },
  { slug: 'chile-primera', name: 'Primera División de Chile', country: 'Chile', countryCode: 'CL', region: 'SOUTH_AMERICA', type: 'LEAGUE', apiFootballId: 265, oddsApiKey: 'soccer_chile_campeonato', seasonMode: 'CALENDAR', priority: 13 },
  { slug: 'uruguay-primera', name: 'Primera División de Uruguay', country: 'Uruguay', countryCode: 'UY', region: 'SOUTH_AMERICA', type: 'LEAGUE', apiFootballId: 268, seasonMode: 'CALENDAR', priority: 14 },
  { slug: 'colombia-primera-a', name: 'Primera A de Colombia', country: 'Colombia', countryCode: 'CO', region: 'SOUTH_AMERICA', type: 'LEAGUE', apiFootballId: 239, seasonMode: 'CALENDAR', priority: 15 },
  // ── Europa ──
  { slug: 'uefa-champions-league', name: 'UEFA Champions League', country: 'Europe', countryCode: null, region: 'EUROPE', type: 'INTERNATIONAL', apiFootballId: 2, oddsApiKey: 'soccer_uefa_champs_league', seasonMode: 'SPLIT', priority: 20, featured: true },
  { slug: 'premier-league', name: 'Premier League', country: 'England', countryCode: 'GB', region: 'EUROPE', type: 'LEAGUE', apiFootballId: 39, oddsApiKey: 'soccer_epl', seasonMode: 'SPLIT', priority: 21, featured: true },
  { slug: 'la-liga', name: 'La Liga', country: 'Spain', countryCode: 'ES', region: 'EUROPE', type: 'LEAGUE', apiFootballId: 140, oddsApiKey: 'soccer_spain_la_liga', seasonMode: 'SPLIT', priority: 22 },
  { slug: 'serie-a-italia', name: 'Serie A', country: 'Italy', countryCode: 'IT', region: 'EUROPE', type: 'LEAGUE', apiFootballId: 135, oddsApiKey: 'soccer_italy_serie_a', seasonMode: 'SPLIT', priority: 23 },
  { slug: 'bundesliga', name: 'Bundesliga', country: 'Germany', countryCode: 'DE', region: 'EUROPE', type: 'LEAGUE', apiFootballId: 78, oddsApiKey: 'soccer_germany_bundesliga', seasonMode: 'SPLIT', priority: 24 },
  { slug: 'ligue-1', name: 'Ligue 1', country: 'France', countryCode: 'FR', region: 'EUROPE', type: 'LEAGUE', apiFootballId: 61, oddsApiKey: 'soccer_france_ligue_one', seasonMode: 'SPLIT', priority: 25 },
  { slug: 'primeira-liga', name: 'Primeira Liga', country: 'Portugal', countryCode: 'PT', region: 'EUROPE', type: 'LEAGUE', apiFootballId: 94, oddsApiKey: 'soccer_portugal_primeira_liga', seasonMode: 'SPLIT', priority: 26 },
  { slug: 'eredivisie', name: 'Eredivisie', country: 'Netherlands', countryCode: 'NL', region: 'EUROPE', type: 'LEAGUE', apiFootballId: 88, oddsApiKey: 'soccer_netherlands_eredivisie', seasonMode: 'SPLIT', priority: 27 },
  { slug: 'uefa-europa-league', name: 'UEFA Europa League', country: 'Europe', countryCode: null, region: 'EUROPE', type: 'INTERNATIONAL', apiFootballId: 3, oddsApiKey: 'soccer_uefa_europa_league', seasonMode: 'SPLIT', priority: 28 },
  { slug: 'uefa-conference-league', name: 'UEFA Conference League', country: 'Europe', countryCode: null, region: 'EUROPE', type: 'INTERNATIONAL', apiFootballId: 848, oddsApiKey: 'soccer_uefa_europa_conference_league', seasonMode: 'SPLIT', priority: 29 },
  { slug: 'fa-cup', name: 'FA Cup', country: 'England', countryCode: 'GB', region: 'EUROPE', type: 'CUP', apiFootballId: 45, oddsApiKey: 'soccer_fa_cup', seasonMode: 'SPLIT', priority: 30 },
  { slug: 'copa-del-rey', name: 'Copa del Rey', country: 'Spain', countryCode: 'ES', region: 'EUROPE', type: 'CUP', apiFootballId: 143, seasonMode: 'SPLIT', priority: 31 },
  { slug: 'coppa-italia', name: 'Coppa Italia', country: 'Italy', countryCode: 'IT', region: 'EUROPE', type: 'CUP', apiFootballId: 137, seasonMode: 'SPLIT', priority: 32 },
  { slug: 'dfb-pokal', name: 'DFB-Pokal', country: 'Germany', countryCode: 'DE', region: 'EUROPE', type: 'CUP', apiFootballId: 81, oddsApiKey: 'soccer_germany_dfb_pokal', seasonMode: 'SPLIT', priority: 33 },
  { slug: 'coupe-de-france', name: 'Coupe de France', country: 'France', countryCode: 'FR', region: 'EUROPE', type: 'CUP', apiFootballId: 66, seasonMode: 'SPLIT', priority: 34 },
  { slug: 'taca-de-portugal', name: 'Taça de Portugal', country: 'Portugal', countryCode: 'PT', region: 'EUROPE', type: 'CUP', apiFootballId: 96, seasonMode: 'SPLIT', priority: 35 },
  // ── Outras ──
  { slug: 'mls', name: 'MLS', country: 'USA', countryCode: 'US', region: 'OTHER', type: 'LEAGUE', apiFootballId: 253, oddsApiKey: 'soccer_usa_mls', seasonMode: 'CALENDAR', priority: 40 },
  { slug: 'saudi-pro-league', name: 'Saudi Pro League', country: 'Saudi Arabia', countryCode: 'SA', region: 'OTHER', type: 'LEAGUE', apiFootballId: 307, seasonMode: 'SPLIT', priority: 41 },
  { slug: 'fifa-world-cup', name: 'FIFA World Cup', country: 'World', countryCode: null, region: 'WORLD', type: 'INTERNATIONAL', apiFootballId: 1, oddsApiKey: 'soccer_fifa_world_cup', seasonMode: 'CALENDAR', priority: 50 },
  { slug: 'copa-america', name: 'Copa América', country: 'South America', countryCode: null, region: 'WORLD', type: 'INTERNATIONAL', apiFootballId: 9, seasonMode: 'CALENDAR', priority: 51 },
  { slug: 'euro', name: 'UEFA Euro', country: 'Europe', countryCode: null, region: 'WORLD', type: 'INTERNATIONAL', apiFootballId: 4, seasonMode: 'CALENDAR', priority: 52 },
  { slug: 'fifa-club-world-cup', name: 'FIFA Club World Cup', country: 'World', countryCode: null, region: 'WORLD', type: 'INTERNATIONAL', apiFootballId: 15, seasonMode: 'CALENDAR', priority: 53 },
];

export function seasonFor(c: Pick<CatalogCompetition, 'seasonMode'>, d: Date): number {
  const y = d.getUTCFullYear();
  return c.seasonMode === 'CALENDAR' ? y : d.getUTCMonth() >= 6 ? y : y - 1;
}
