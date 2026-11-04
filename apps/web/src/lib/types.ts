export interface Selection { key: string; oddsId: number; odds: number; oddsK: number; version?: number }
export interface Market { id: string; key: string; type: string; line: number | null; status: string; suspensionReason: string | null; selections: Selection[] }
export interface TeamRef { id: string; name: string; shortName: string | null; logoUrl: string | null; primaryColor?: string | null; secondaryColor?: string | null; crestPattern?: string | null }
export interface CompetitionRef { id: string; slug: string; name: string; country: string; countryCode: string | null; region: string; priority: number }
export interface MatchSummary {
  id: string; kickoffAt: string; status: string; round: string | null; homeGoals: number | null; awayGoals: number | null;
  home: TeamRef; away: TeamRef; competition: CompetitionRef; marketCount: number;
  mainMarket: null | { id: string; status: string; selections: Selection[] };
}
export interface MatchList { tz: string; today: string; filter: string; total: number; groups: { competition: CompetitionRef; matches: MatchSummary[] }[] }
export interface MatchDetail extends MatchSummary {
  markets: Market[];
  model: null | { version: string; lambdaHome: number; lambdaAway: number; status: string; suspensionReason: string | null; external: any; at: string };
  form: { home: string[]; away: string[] };
}
export interface User { id: string; email: string; displayName: string; role: 'USER' | 'SUPPORT' | 'RISK' | 'ADMIN'; locale: string; timezone: string; mfaEnabled: boolean; sessionMfa?: boolean; country: string; kycStatus: string }
export interface Bet {
  id: string; code: string; type: 'SINGLE' | 'MULTIPLE'; status: 'OPEN' | 'WON' | 'LOST' | 'VOID'; stake: string; currency: string; combinedOdds: number;
  potentialPayout: string; payout: string | null; placedAt: string; settledAt: string | null; settlementVersion: number;
  legs: { id: string; matchId: string; home: string; away: string; kickoffAt: string; matchStatus: string; score: string | null; marketKey: string; selection: string; odds: number; result: string; voidReason: string | null }[];
}
