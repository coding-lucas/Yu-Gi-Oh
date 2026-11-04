import { MarketType } from '@athosbet/shared';
import { AdjustedLambdas, MatchContext, adjustedLambdas } from './adjustments';
import { FairMarket, deriveMarkets, outcomeProbs, totalProb } from './derive';
import { MarginMethod, applyMargin, devig, probToOdds } from './margin';
import { ScoreMatrix, scoreMatrix } from './poisson';
import { RatingModel } from './ratings';

export const MODEL_VERSION = 'dc-poisson-1.0.0';

export interface PricingConfig {
  /** margin per market type, e.g. 0.05 = 5% overround */
  margins: Record<MarketType, number>;
  marginMethod: MarginMethod;
  /** minimum matches in the fitted sample for each team before prices are published */
  minTeamMatches: number;
  /** minimum matches per team before correct-score markets are offered */
  minTeamMatchesCorrectScore: number;
  /** weight given to the external consensus when available (0 = model only) */
  externalWeight: number;
  /** suspend if |model − market| on any 1X2 outcome exceeds this (absolute probability) */
  maxExternalDeviation: number;
  minOdds: number;
  maxOdds: number;
  maxOddsCorrectScore: number;
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  margins: {
    MATCH_RESULT: 0.05,
    DOUBLE_CHANCE: 0.05,
    DRAW_NO_BET: 0.05,
    BOTH_TEAMS_TO_SCORE: 0.06,
    TOTAL_GOALS: 0.06,
    CORRECT_SCORE: 0.18,
  },
  marginMethod: 'POWER',
  minTeamMatches: 8,
  minTeamMatchesCorrectScore: 20,
  externalWeight: 0.35,
  maxExternalDeviation: 0.12,
  minOdds: 1.01,
  maxOdds: 51,
  maxOddsCorrectScore: 151,
};

/** External consensus (e.g. The Odds API) in decimal odds, already averaged across bookmakers. */
export interface ExternalOdds {
  matchResult?: { home: number; draw: number; away: number };
  totals25?: { over: number; under: number };
  bookmakers?: number;
}

export type SuspensionReason =
  | 'INSUFFICIENT_DATA'
  | 'INCONSISTENT_DATA'
  | 'MODEL_MARKET_DIVERGENCE'
  | 'LOW_CONFIDENCE';

export interface PricedSelection {
  key: string;
  fairProb: number;
  odds: number; // decimal, on the price ladder
}

export interface PricedMarket {
  key: string;
  type: MarketType;
  line: number | null;
  status: 'OPEN' | 'SUSPENDED';
  suspensionReason?: SuspensionReason;
  selections: PricedSelection[];
  overround: number;
}

export interface PricingResult {
  modelVersion: string;
  lambdas: { home: number; away: number };
  rawLambdas: { home: number; away: number } | null;
  factors: Record<string, number>;
  external: { used: boolean; deviation: number | null; probs?: { HOME: number; DRAW: number; AWAY: number } };
  markets: PricedMarket[];
  status: 'OPEN' | 'SUSPENDED';
  suspensionReason?: SuspensionReason;
  diagnostics: string[];
}

export interface PriceMatchInput {
  model: RatingModel;
  homeId: string;
  awayId: string;
  context?: MatchContext;
  external?: ExternalOdds;
  config?: Partial<PricingConfig>;
}

export function priceMatch(input: PriceMatchInput): PricingResult {
  const cfg: PricingConfig = { ...DEFAULT_PRICING_CONFIG, ...input.config, margins: { ...DEFAULT_PRICING_CONFIG.margins, ...input.config?.margins } };
  const diagnostics: string[] = [];
  const { model, homeId, awayId } = input;
  const th = model.teams[homeId];
  const ta = model.teams[awayId];

  const suspendedAll = (reason: SuspensionReason, lambdas: AdjustedLambdas | null): PricingResult => ({
    modelVersion: MODEL_VERSION,
    lambdas: lambdas ? { home: lambdas.home, away: lambdas.away } : { home: 0, away: 0 },
    rawLambdas: lambdas ? { home: lambdas.home, away: lambdas.away } : null,
    factors: lambdas?.factors ?? {},
    external: { used: false, deviation: null },
    markets: [],
    status: 'SUSPENDED',
    suspensionReason: reason,
    diagnostics,
  });

  if (!th || !ta) {
    diagnostics.push(`team not in model: ${!th ? homeId : ''} ${!ta ? awayId : ''}`.trim());
    return suspendedAll('INSUFFICIENT_DATA', null);
  }
  if (th.matches < cfg.minTeamMatches || ta.matches < cfg.minTeamMatches) {
    diagnostics.push(`sample too small (home ${th.matches}, away ${ta.matches}, min ${cfg.minTeamMatches})`);
    return suspendedAll('INSUFFICIENT_DATA', null);
  }
  const adj = adjustedLambdas(model, homeId, awayId, input.context);
  if (!adj || !isSane(adj.home) || !isSane(adj.away)) {
    diagnostics.push(`expected goals out of range: ${adj?.home}/${adj?.away}`);
    return suspendedAll('INCONSISTENT_DATA', adj);
  }

  let lh = adj.home;
  let la = adj.away;
  let matrix = scoreMatrix(lh, la, model.rho);
  const ext: PricingResult['external'] = { used: false, deviation: null };

  if (input.external?.matchResult) {
    const { home, draw, away } = input.external.matchResult;
    if ([home, draw, away].some((o) => !(o > 1))) {
      diagnostics.push('external odds invalid — ignored');
    } else {
      const [pH, pD, pA] = devig([home, draw, away], 'POWER');
      const mp = outcomeProbs(matrix);
      const dev = Math.max(Math.abs(mp.HOME - pH), Math.abs(mp.DRAW - pD), Math.abs(mp.AWAY - pA));
      ext.deviation = dev;
      ext.probs = { HOME: pH, DRAW: pD, AWAY: pA };
      if (dev > cfg.maxExternalDeviation) {
        diagnostics.push(`model deviates ${(dev * 100).toFixed(1)}pp from market consensus`);
        const r = suspendedAll('MODEL_MARKET_DIVERGENCE', adj);
        r.external = ext;
        return r;
      }
      if (cfg.externalWeight > 0) {
        const w = cfg.externalWeight;
        const target = { HOME: (1 - w) * mp.HOME + w * pH, AWAY: (1 - w) * mp.AWAY + w * pA };
        let overTarget: number | undefined;
        if (input.external.totals25 && input.external.totals25.over > 1 && input.external.totals25.under > 1) {
          const [po] = devig([input.external.totals25.over, input.external.totals25.under], 'POWER');
          overTarget = (1 - w) * totalProb(matrix, (t) => t > 2.5) + w * po;
        }
        [lh, la] = calibrateLambdas(lh, la, model.rho, target, overTarget);
        matrix = scoreMatrix(lh, la, model.rho);
        ext.used = true;
      }
    }
  }

  const fair = deriveMarkets(matrix);
  const sumCheck = Object.values(fair[0].probs).reduce((a, b) => a + b, 0);
  if (Math.abs(sumCheck - 1) > 1e-9 || fair.some((m) => Object.values(m.probs).some((p) => !Number.isFinite(p) || p < 0))) {
    diagnostics.push('probability vector invalid');
    return suspendedAll('INCONSISTENT_DATA', adj);
  }

  const csAllowed = th.matches >= cfg.minTeamMatchesCorrectScore && ta.matches >= cfg.minTeamMatchesCorrectScore;
  const markets = fair.map((fm) => priceMarket(fm, cfg, csAllowed));
  return {
    modelVersion: MODEL_VERSION,
    lambdas: { home: lh, away: la },
    rawLambdas: { home: adj.home, away: adj.away },
    factors: adj.factors,
    external: ext,
    markets,
    status: 'OPEN',
    diagnostics,
  };
}

function isSane(l: number) {
  return Number.isFinite(l) && l >= 0.15 && l <= 4.5;
}

function priceMarket(fm: FairMarket, cfg: PricingConfig, csAllowed: boolean): PricedMarket {
  const margin = cfg.margins[fm.type];
  const keys = Object.keys(fm.probs);
  const p = keys.map((k) => fm.probs[k]);
  const maxOdds = fm.type === 'CORRECT_SCORE' ? cfg.maxOddsCorrectScore : cfg.maxOdds;
  let q: number[];
  if (fm.type === 'DOUBLE_CHANCE') {
    // each double-chance selection is priced against its complement
    q = p.map((pi) => applyMargin([pi, 1 - pi], margin, cfg.marginMethod)[0]);
  } else {
    q = applyMargin(p, margin, cfg.marginMethod);
  }
  const selections = keys.map((k, i) => ({ key: k, fairProb: p[i], odds: probToOdds(q[i], cfg.minOdds, maxOdds) }));
  const realised = fm.type === 'DOUBLE_CHANCE' ? margin : selections.reduce((s, x) => s + 1 / x.odds, 0) - 1;
  const market: PricedMarket = { key: fm.key, type: fm.type, line: fm.line, status: 'OPEN', selections, overround: realised };
  if (fm.type === 'CORRECT_SCORE' && !csAllowed) {
    market.status = 'SUSPENDED';
    market.suspensionReason = 'LOW_CONFIDENCE';
  }
  // A market where the shortest price is the minimum carries no value and too much risk.
  if (fm.type !== 'CORRECT_SCORE' && selections.some((s) => s.fairProb > 0.97)) {
    market.status = 'SUSPENDED';
    market.suspensionReason = 'LOW_CONFIDENCE';
  }
  return market;
}

/**
 * Adjusts (λh, λa) so that the matrix matches a blended 1X2 target (and optionally P(over 2.5)),
 * keeping every derived market consistent. Simple multiplicative coordinate search on log λ.
 */
export function calibrateLambdas(
  lh: number,
  la: number,
  rho: number,
  target: { HOME: number; AWAY: number },
  overTarget?: number,
): [number, number] {
  const loss = (h: number, a: number) => {
    const m: ScoreMatrix = scoreMatrix(h, a, rho);
    const o = outcomeProbs(m);
    let l = (o.HOME - target.HOME) ** 2 + (o.AWAY - target.AWAY) ** 2;
    if (overTarget !== undefined) l += (totalProb(m, (t) => t > 2.5) - overTarget) ** 2;
    return l;
  };
  let x = Math.log(lh);
  let y = Math.log(la);
  let step = 0.2;
  let best = loss(lh, la);
  for (let i = 0; i < 200 && step > 1e-5; i++) {
    let improved = false;
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
      const v = loss(Math.exp(x + dx), Math.exp(y + dy));
      if (v < best) {
        best = v;
        x += dx;
        y += dy;
        improved = true;
        break;
      }
    }
    if (!improved) step /= 2;
  }
  return [Math.exp(x), Math.exp(y)];
}
