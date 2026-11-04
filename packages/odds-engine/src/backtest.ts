import { adjustedLambdas } from './adjustments';
import { outcomeProbs, totalProb } from './derive';
import { brierScore, calibration, logLoss, rankedProbabilityScore } from './metrics';
import { scoreMatrix } from './poisson';
import { FitOptions, HistoricalMatch, RatingModel, fitRatings } from './ratings';

export interface BacktestOptions {
  /** matches used only for training before the first prediction */
  warmup: number;
  /** refit the model after this many new matches */
  refitEvery: number;
  /** skip predictions when either team has fewer matches than this */
  minTeamMatches: number;
  fit?: Omit<FitOptions, 'asOf'>;
  useForm?: boolean;
}

export interface BacktestReport {
  n: number;
  model: { brier: number; logLoss: number; rps: number; ece: number };
  baseline: { brier: number; logLoss: number; rps: number };
  totals25: { brier: number; logLoss: number; ece: number };
  calibration: ReturnType<typeof calibration>['bins'];
  skillVsBaseline: number; // 1 − brier/brierBaseline
}

/**
 * Walk-forward backtest: the model is only ever fitted on matches strictly before the predicted
 * fixture, so there is no look-ahead leakage. Baseline = historical base rates of H/D/A.
 */
export function walkForwardBacktest(matches: HistoricalMatch[], opts: BacktestOptions): BacktestReport {
  const sorted = [...matches].sort((a, b) => a.date.getTime() - b.date.getTime());
  const preds: number[][] = [];
  const base: number[][] = [];
  const outcomes: number[] = [];
  const ouPreds: number[][] = [];
  const ouOut: number[] = [];
  let model: RatingModel | null = null;
  let sinceFit = Infinity;
  const counts = [0, 0, 0];

  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    const outcome = m.homeGoals > m.awayGoals ? 0 : m.homeGoals === m.awayGoals ? 1 : 2;
    if (i >= opts.warmup) {
      if (!model || sinceFit >= opts.refitEvery) {
        model = fitRatings(sorted.slice(0, i), { ...opts.fit, asOf: m.date });
        sinceFit = 0;
      }
      const th = model.teams[m.homeId];
      const ta = model.teams[m.awayId];
      if (th && ta && th.matches >= opts.minTeamMatches && ta.matches >= opts.minTeamMatches) {
        const l = adjustedLambdas(model, m.homeId, m.awayId, opts.useForm ? { history: sorted.slice(0, i), asOf: m.date, neutral: m.neutral } : { neutral: m.neutral });
        if (l) {
          const mat = scoreMatrix(l.home, l.away, model.rho);
          const o = outcomeProbs(mat);
          preds.push([o.HOME, o.DRAW, o.AWAY]);
          const tot = counts[0] + counts[1] + counts[2];
          base.push(counts.map((c) => (c + 1) / (tot + 3)));
          outcomes.push(outcome);
          const over = totalProb(mat, (t) => t > 2.5);
          ouPreds.push([over, 1 - over]);
          ouOut.push(m.homeGoals + m.awayGoals > 2.5 ? 0 : 1);
        }
      }
      sinceFit++;
    }
    counts[outcome]++;
  }
  if (preds.length === 0) throw new Error('No predictions produced — not enough data');
  const flatP: number[] = [];
  const flatH: boolean[] = [];
  preds.forEach((p, i) => p.forEach((pk, k) => { flatP.push(pk); flatH.push(outcomes[i] === k); }));
  const cal = calibration(flatP, flatH, 10);
  const ouCal = calibration(ouPreds.map((p) => p[0]), ouOut.map((o) => o === 0), 10);
  const brier = brierScore(preds, outcomes);
  const bBrier = brierScore(base, outcomes);
  return {
    n: preds.length,
    model: { brier, logLoss: logLoss(preds, outcomes), rps: rankedProbabilityScore(preds, outcomes), ece: cal.ece },
    baseline: { brier: bBrier, logLoss: logLoss(base, outcomes), rps: rankedProbabilityScore(base, outcomes) },
    totals25: { brier: brierScore(ouPreds, ouOut), logLoss: logLoss(ouPreds, ouOut), ece: ouCal.ece },
    calibration: cal.bins,
    skillVsBaseline: 1 - brier / bBrier,
  };
}
