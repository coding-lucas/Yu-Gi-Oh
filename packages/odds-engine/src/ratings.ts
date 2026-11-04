import { dcTau, poissonPmf, rhoBounds } from './poisson';

export interface HistoricalMatch {
  homeId: string;
  awayId: string;
  homeGoals: number;
  awayGoals: number;
  date: Date;
  neutral?: boolean;
}

export interface TeamRating {
  attack: number; // log-scale, + is better
  defense: number; // log-scale, + is better (concedes less)
  matches: number; // number of matches used to fit this team
  effectiveMatches: number; // sum of time-decay weights
}

export interface RatingModel {
  mu: number; // log baseline goals per team per match
  homeAdvantage: number; // log-scale
  rho: number; // Dixon–Coles dependence
  teams: Record<string, TeamRating>;
  fittedAt: string;
  nMatches: number;
  logLikelihood: number;
}

export interface FitOptions {
  asOf: Date;
  /** time decay per day (Dixon–Coles ξ). 0.0019/day ≈ half-life of one year */
  xi?: number;
  /** L2 shrinkage of team parameters towards the league average (protects small samples) */
  ridge?: number;
  maxIter?: number;
  tol?: number;
  fitRho?: boolean;
}

const DAY = 86_400_000;

/**
 * Fits a Maher/Dixon–Coles style model by weighted Poisson maximum likelihood:
 *   log λ_home = μ + γ·[not neutral] + att_home − def_away
 *   log λ_away = μ + att_away − def_home
 * Parameters are estimated with damped Newton coordinate updates and sum-to-zero
 * identification constraints. Opponent quality is therefore explicitly accounted for: scoring
 * against a strong defence raises attack more than scoring against a weak one.
 */
export function fitRatings(matches: HistoricalMatch[], opts: FitOptions): RatingModel {
  const xi = opts.xi ?? 0.0019;
  const ridge = opts.ridge ?? 2;
  const maxIter = opts.maxIter ?? 200;
  const tol = opts.tol ?? 1e-7;
  const asOf = opts.asOf.getTime();
  const data = matches
    .filter((m) => m.date.getTime() < asOf)
    .map((m) => ({ ...m, w: Math.exp(-xi * Math.max(0, (asOf - m.date.getTime()) / DAY)) }));

  const ids = new Set<string>();
  for (const m of data) {
    ids.add(m.homeId);
    ids.add(m.awayId);
  }
  const att: Record<string, number> = {};
  const def: Record<string, number> = {};
  const count: Record<string, number> = {};
  const eff: Record<string, number> = {};
  for (const id of ids) {
    att[id] = 0;
    def[id] = 0;
    count[id] = 0;
    eff[id] = 0;
  }
  for (const m of data) {
    count[m.homeId]++;
    count[m.awayId]++;
    eff[m.homeId] += m.w;
    eff[m.awayId] += m.w;
  }

  const totalW = data.reduce((s, m) => s + m.w, 0);
  const goalsW = data.reduce((s, m) => s + m.w * (m.homeGoals + m.awayGoals), 0);
  let mu = Math.log(Math.max(goalsW / Math.max(2 * totalW, 1e-9), 0.2));
  let home = 0.2;

  const lam = (m: (typeof data)[number]) => ({
    h: Math.exp(mu + (m.neutral ? 0 : home) + att[m.homeId] - def[m.awayId]),
    a: Math.exp(mu + att[m.awayId] - def[m.homeId]),
  });

  const n = ids.size || 1;
  type Block = 'att' | 'def' | 'home' | 'mu';
  // Block coordinate (Gauss–Seidel) Newton updates: inside a block every parameter is separable,
  // so the diagonal Newton step is exact; λ is recomputed between blocks.
  const step = (block: Block): number => {
    const g: Record<string, number> = {};
    const h: Record<string, number> = {};
    for (const id of ids) g[id] = h[id] = 0;
    let gs = 0, hs = 0;
    for (const m of data) {
      const l = lam(m);
      const rh = m.w * (m.homeGoals - l.h);
      const ra = m.w * (m.awayGoals - l.a);
      if (block === 'att') {
        g[m.homeId] += rh; h[m.homeId] += m.w * l.h;
        g[m.awayId] += ra; h[m.awayId] += m.w * l.a;
      } else if (block === 'def') {
        g[m.awayId] -= rh; h[m.awayId] += m.w * l.h;
        g[m.homeId] -= ra; h[m.homeId] += m.w * l.a;
      } else if (block === 'home') {
        if (!m.neutral) { gs += rh; hs += m.w * l.h; }
      } else {
        gs += rh + ra; hs += m.w * (l.h + l.a);
      }
    }
    let max = 0;
    if (block === 'att' || block === 'def') {
      const p = block === 'att' ? att : def;
      for (const id of ids) {
        const s = clampStep((g[id] - ridge * p[id]) / (h[id] + ridge));
        p[id] += s;
        max = Math.max(max, Math.abs(s));
      }
      // identification: Σ = 0, absorbed into μ (keeps every λ unchanged)
      const mean = [...ids].reduce((s, id) => s + p[id], 0) / n;
      for (const id of ids) p[id] -= mean;
      mu += block === 'att' ? mean : -mean;
    } else if (hs > 0) {
      const s = clampStep(gs / hs);
      if (block === 'home') home += s; else mu += s;
      max = Math.abs(s);
    }
    return max;
  };

  for (let iter = 0; iter < maxIter && data.length > 0; iter++) {
    const maxStep = Math.max(step('att'), step('def'), step('home'), step('mu'));
    if (maxStep < tol) break;
  }

  let rho = 0;
  if (opts.fitRho !== false && data.length >= 30) {
    rho = fitRho(data, (m) => lam(m));
  }

  let ll = 0;
  for (const m of data) {
    const l = lam(m);
    ll += m.w * Math.log(Math.max(1e-300, poissonPmf(m.homeGoals, l.h) * poissonPmf(m.awayGoals, l.a) * dcTau(m.homeGoals, m.awayGoals, l.h, l.a, rho)));
  }

  const teams: Record<string, TeamRating> = {};
  for (const id of ids) teams[id] = { attack: att[id], defense: def[id], matches: count[id], effectiveMatches: eff[id] };
  return { mu, homeAdvantage: home, rho, teams, fittedAt: new Date(asOf).toISOString(), nMatches: data.length, logLikelihood: ll };
}

function clampStep(s: number) {
  return Math.max(-0.5, Math.min(0.5, s));
}

/** Profile likelihood for ρ with λ fixed (golden-section search over [-0.25, 0.25]). */
function fitRho<T extends HistoricalMatch & { w: number }>(data: T[], lam: (m: T) => { h: number; a: number }): number {
  const pre = data
    .filter((m) => m.homeGoals <= 1 && m.awayGoals <= 1)
    .map((m) => ({ m, l: lam(m) }));
  const f = (rho: number) => {
    let s = 0;
    for (const { m, l } of pre) {
      const [lo, hi] = rhoBounds(l.h, l.a);
      if (rho <= lo || rho >= hi) return -Infinity;
      s += m.w * Math.log(Math.max(1e-12, dcTau(m.homeGoals, m.awayGoals, l.h, l.a, rho)));
    }
    return s;
  };
  let a = -0.25;
  let b = 0.25;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  for (let i = 0; i < 60; i++) {
    if (f(c) > f(d)) b = d;
    else a = c;
    c = b - g * (b - a);
    d = a + g * (b - a);
  }
  return (a + b) / 2;
}

export interface ExpectedGoals {
  home: number;
  away: number;
}

export function baseLambdas(model: RatingModel, homeId: string, awayId: string, neutral = false): ExpectedGoals | null {
  const h = model.teams[homeId];
  const a = model.teams[awayId];
  if (!h || !a) return null;
  return {
    home: Math.exp(model.mu + (neutral ? 0 : model.homeAdvantage) + h.attack - a.defense),
    away: Math.exp(model.mu + a.attack - h.defense),
  };
}
