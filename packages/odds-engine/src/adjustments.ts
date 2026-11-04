import { baseLambdas, HistoricalMatch, RatingModel } from './ratings';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Recent form: ratio of goals scored/conceded vs. model expectation over the last N matches,
 * shrunk towards 1 so that a hot streak moves prices moderately. Returned factors are bounded.
 */
export function formFactors(
  model: RatingModel,
  history: HistoricalMatch[],
  teamId: string,
  asOf: Date,
  n = 6,
): { attack: number; defense: number; sample: number } {
  const recent = history
    .filter((m) => (m.homeId === teamId || m.awayId === teamId) && m.date < asOf)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, n);
  let gf = 0, ga = 0, xf = 0, xa = 0;
  for (const m of recent) {
    const l = baseLambdas(model, m.homeId, m.awayId, m.neutral);
    if (!l) continue;
    const isHome = m.homeId === teamId;
    gf += isHome ? m.homeGoals : m.awayGoals;
    ga += isHome ? m.awayGoals : m.homeGoals;
    xf += isHome ? l.home : l.away;
    xa += isHome ? l.away : l.home;
  }
  if (recent.length === 0 || xf === 0 || xa === 0) return { attack: 1, defense: 1, sample: 0 };
  const k = recent.length / (recent.length + 12); // shrinkage
  return {
    attack: clamp(1 + k * (gf / xf - 1), 0.88, 1.12),
    defense: clamp(1 + k * (ga / xa - 1), 0.88, 1.12), // >1 means conceding more than expected
    sample: recent.length,
  };
}

/** Head-to-head goal tendency, heavily shrunk; only used with ≥3 meetings. */
export function headToHeadFactor(model: RatingModel, history: HistoricalMatch[], homeId: string, awayId: string, asOf: Date) {
  const h2h = history.filter(
    (m) => m.date < asOf && ((m.homeId === homeId && m.awayId === awayId) || (m.homeId === awayId && m.awayId === homeId)),
  );
  if (h2h.length < 3) return { home: 1, away: 1, sample: h2h.length };
  let gH = 0, gA = 0, xH = 0, xA = 0;
  for (const m of h2h) {
    const l = baseLambdas(model, m.homeId, m.awayId, m.neutral);
    if (!l) continue;
    const homeIsHome = m.homeId === homeId;
    gH += homeIsHome ? m.homeGoals : m.awayGoals;
    gA += homeIsHome ? m.awayGoals : m.homeGoals;
    xH += homeIsHome ? l.home : l.away;
    xA += homeIsHome ? l.away : l.home;
  }
  if (xH === 0 || xA === 0) return { home: 1, away: 1, sample: h2h.length };
  const k = h2h.length / (h2h.length + 15);
  return { home: clamp(1 + k * (gH / xH - 1), 0.92, 1.08), away: clamp(1 + k * (gA / xA - 1), 0.92, 1.08), sample: h2h.length };
}

/**
 * Availability (line-ups, injuries, suspensions). `attackLoss`/`defenseLoss` ∈ [0,1] is the share of the
 * team's attacking/defensive contribution that is unavailable (e.g. computed from minutes-weighted player
 * ratings). A full loss reduces expected goals by at most 25%.
 */
export interface Availability {
  attackLoss?: number;
  defenseLoss?: number;
}

export interface MatchContext {
  neutral?: boolean;
  homeAvailability?: Availability;
  awayAvailability?: Availability;
  history?: HistoricalMatch[];
  asOf?: Date;
}

export interface AdjustedLambdas {
  home: number;
  away: number;
  factors: Record<string, number>;
}

export function adjustedLambdas(model: RatingModel, homeId: string, awayId: string, ctx: MatchContext = {}): AdjustedLambdas | null {
  const base = baseLambdas(model, homeId, awayId, ctx.neutral);
  if (!base) return null;
  const f: Record<string, number> = {};
  let h = base.home;
  let a = base.away;
  if (ctx.history && ctx.asOf) {
    const fh = formFactors(model, ctx.history, homeId, ctx.asOf);
    const fa = formFactors(model, ctx.history, awayId, ctx.asOf);
    h *= fh.attack * fa.defense;
    a *= fa.attack * fh.defense;
    f.formHomeAttack = fh.attack; f.formHomeDefense = fh.defense;
    f.formAwayAttack = fa.attack; f.formAwayDefense = fa.defense;
    const hh = headToHeadFactor(model, ctx.history, homeId, awayId, ctx.asOf);
    h *= hh.home;
    a *= hh.away;
    f.h2hHome = hh.home; f.h2hAway = hh.away;
  }
  const av = (x?: Availability) => ({ att: 1 - 0.25 * clamp(x?.attackLoss ?? 0, 0, 1), def: 1 + 0.25 * clamp(x?.defenseLoss ?? 0, 0, 1) });
  const ah = av(ctx.homeAvailability);
  const aa = av(ctx.awayAvailability);
  h *= ah.att * aa.def;
  a *= aa.att * ah.def;
  f.availHome = ah.att; f.availAway = aa.att;
  return { home: h, away: a, factors: f };
}
