import type { MatchStatus } from '../../db/schema';

export interface ProviderTeam {
  providerId: string;
  name: string;
  shortName?: string;
  logoUrl?: string | null;
  country?: string | null;
}

export interface ProviderFixture {
  providerId: string;
  season: number;
  round?: string | null;
  kickoffAt: Date;
  status: MatchStatus;
  statusDetail?: string | null;
  home: ProviderTeam;
  away: ProviderTeam;
  /** regular-time (90') score — extra time and penalties excluded */
  homeGoals: number | null;
  awayGoals: number | null;
  venue?: string | null;
  neutral?: boolean;
}

export interface ProviderInjury {
  teamProviderId: string;
  player: string;
  type: string; // "Missing Fixture" | "Questionable"
  reason?: string;
}

export interface CompetitionRef {
  providerId: string; // league id in this provider
  season: number;
  slug: string;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly httpStatus?: number, public readonly retryable = true) {
    super(message);
  }
}

export interface SportsProvider {
  readonly name: string;
  fixtures(comp: CompetitionRef, from: Date, to: Date): Promise<ProviderFixture[]>;
  /** finished matches used for model fitting */
  history(comp: CompetitionRef): Promise<ProviderFixture[]>;
  injuries?(fixtureProviderId: string): Promise<ProviderInjury[]>;
  /** league coverage flags reported by the provider */
  coverage?(comp: CompetitionRef): Promise<Record<string, unknown> | null>;
}
