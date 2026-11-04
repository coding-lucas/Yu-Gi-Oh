import { describe, expect, it } from 'vitest';
import {
  scoreMatrix, poissonPmf, dcTau, fitRatings, simulateLeague, TrueTeam, applyMargin, devig, roundToLadder,
  priceMatch, deriveMarkets, outcomeProbs, brierScore, logLoss, calibration, walkForwardBacktest,
  rng, rankedProbabilityScore, calibrateLambdas, overround, adjustedLambdas, sampleScore,
} from '../src';

function league(n = 20, seed = 7): TrueTeam[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({ id: `T${i}`, attack: (r() - 0.5) * 0.8, defense: (r() - 0.5) * 0.8 }));
}

describe('poisson / dixon-coles', () => {
  it('pmf sums to one', () => {
    let s = 0;
    for (let k = 0; k < 30; k++) s += poissonPmf(k, 1.7);
    expect(s).toBeCloseTo(1, 10);
  });
  it('score matrix is a distribution and rho moves low scores', () => {
    const m0 = scoreMatrix(1.4, 1.1, 0);
    const m1 = scoreMatrix(1.4, 1.1, -0.1);
    const sum = (m: number[][]) => m.flat().reduce((a, b) => a + b, 0);
    expect(sum(m0)).toBeCloseTo(1, 12);
    expect(sum(m1)).toBeCloseTo(1, 12);
    expect(m1[0][0]).toBeGreaterThan(m0[0][0]); // rho<0 inflates 0-0 and 1-1
    expect(m1[1][1]).toBeGreaterThan(m0[1][1]);
    expect(m1[1][0]).toBeLessThan(m0[1][0]);
    expect(dcTau(2, 2, 1, 1, -0.1)).toBe(1);
  });
  it('rejects invalid lambdas', () => {
    expect(() => scoreMatrix(0, 1)).toThrow();
    expect(() => scoreMatrix(NaN, 1)).toThrow();
  });
});

describe('rating fit', () => {
  const teams = league();
  const matches = simulateLeague(teams, { seed: 11, start: new Date('2024-01-01'), rounds: 6 });
  const model = fitRatings(matches, { asOf: new Date('2030-01-01'), xi: 0, ridge: 0.5 });

  it('recovers true team strengths (correlation)', () => {
    const corr = (a: number[], b: number[]) => {
      const ma = a.reduce((x, y) => x + y) / a.length, mb = b.reduce((x, y) => x + y) / b.length;
      let num = 0, da = 0, db = 0;
      a.forEach((v, i) => { num += (v - ma) * (b[i] - mb); da += (v - ma) ** 2; db += (b[i] - mb) ** 2; });
      return num / Math.sqrt(da * db);
    };
    expect(corr(teams.map((t) => t.attack), teams.map((t) => model.teams[t.id].attack))).toBeGreaterThan(0.85);
    expect(corr(teams.map((t) => t.defense), teams.map((t) => model.teams[t.id].defense))).toBeGreaterThan(0.85);
    expect(model.homeAdvantage).toBeGreaterThan(0.1);
    expect(model.homeAdvantage).toBeLessThan(0.4);
  });
  it('ignores matches after asOf (no leakage)', () => {
    const cut = matches[100].date;
    const m = fitRatings(matches, { asOf: cut });
    expect(m.nMatches).toBe(100);
  });
  it('form & availability adjustments are bounded', () => {
    const l = adjustedLambdas(model, 'T0', 'T1', { history: matches, asOf: new Date('2030-01-01'), homeAvailability: { attackLoss: 1 } })!;
    const base = adjustedLambdas(model, 'T0', 'T1', { history: matches, asOf: new Date('2030-01-01') })!;
    expect(l.home / base.home).toBeGreaterThan(0.6);
    expect(l.home / base.home).toBeLessThan(0.9);
    expect(l.factors.availHome).toBeCloseTo(0.75);
  });
});

describe('margins & ladder', () => {
  it('power margin achieves target overround and favours long-shot loading', () => {
    const p = [0.6, 0.25, 0.15];
    const q = applyMargin(p, 0.05, 'POWER');
    expect(q.reduce((a, b) => a + b)).toBeCloseTo(1.05, 6);
    expect(q[2] / p[2]).toBeGreaterThan(q[0] / p[0]);
    const qp = applyMargin(p, 0.05, 'PROPORTIONAL');
    expect(qp[0]).toBeCloseTo(0.63);
  });
  it('devig recovers fair probabilities', () => {
    const fair = devig([1.8, 3.6, 4.5]);
    expect(fair.reduce((a, b) => a + b)).toBeCloseTo(1, 10);
    const pw = devig([1.8, 3.6, 4.5], 'POWER');
    expect(pw.reduce((a, b) => a + b)).toBeCloseTo(1, 6);
    expect(overround([2, 2])).toBeCloseTo(0);
  });
  it('rounds down on the ladder', () => {
    expect(roundToLadder(1.999)).toBe(1.99);
    expect(roundToLadder(2.039)).toBe(2.02);
    expect(roundToLadder(3.07)).toBe(3.05);
    expect(roundToLadder(7.39)).toBe(7.2);
    expect(roundToLadder(1.0)).toBe(1.01);
    expect(roundToLadder(1000, 1.01, 51)).toBe(50);
  });
  it('rejects absurd margins', () => expect(() => applyMargin([0.5, 0.5], 0.9)).toThrow());
});

describe('pricing', () => {
  const teams = league();
  const matches = simulateLeague(teams, { seed: 3, start: new Date('2024-01-01'), rounds: 4 });
  const model = fitRatings(matches, { asOf: new Date('2030-01-01') });

  it('produces consistent markets with margin applied', () => {
    const r = priceMatch({ model, homeId: 'T0', awayId: 'T1' });
    expect(r.status).toBe('OPEN');
    const mr = r.markets.find((m) => m.key === 'MATCH_RESULT')!;
    expect(mr.overround).toBeGreaterThan(0.045);
    expect(mr.overround).toBeLessThan(0.09);
    for (const m of r.markets.filter((x) => x.status === 'OPEN')) for (const s of m.selections) {
      expect(s.odds).toBeGreaterThanOrEqual(1.01);
      // price never exceeds fair odds
      expect(s.odds).toBeLessThanOrEqual(1 / s.fairProb + 1e-9);
    }
    const dnb = r.markets.find((m) => m.key === 'DRAW_NO_BET')!;
    expect(dnb.selections[0].fairProb + dnb.selections[1].fairProb).toBeCloseTo(1);
    const tg = r.markets.filter((m) => m.type === 'TOTAL_GOALS').map((m) => m.selections[0].fairProb);
    for (let i = 1; i < tg.length; i++) expect(tg[i]).toBeLessThan(tg[i - 1]); // P(over) decreasing in line
  });
  it('suspends with insufficient data', () => {
    const r = priceMatch({ model, homeId: 'T0', awayId: 'UNKNOWN' });
    expect(r.status).toBe('SUSPENDED');
    expect(r.suspensionReason).toBe('INSUFFICIENT_DATA');
    const r2 = priceMatch({ model, homeId: 'T0', awayId: 'T1', config: { minTeamMatches: 1000 } });
    expect(r2.suspensionReason).toBe('INSUFFICIENT_DATA');
  });
  it('withholds correct score when confidence is low', () => {
    const r = priceMatch({ model, homeId: 'T0', awayId: 'T1', config: { minTeamMatchesCorrectScore: 999 } });
    expect(r.markets.find((m) => m.type === 'CORRECT_SCORE')!.status).toBe('SUSPENDED');
  });
  it('suspends on divergence from external consensus and blends otherwise', () => {
    const base = priceMatch({ model, homeId: 'T0', awayId: 'T1' });
    const fair = base.markets[0].selections.map((s) => s.fairProb);
    const near = fair.map((p) => 1 / (p * 1.05));
    const blended = priceMatch({ model, homeId: 'T0', awayId: 'T1', external: { matchResult: { home: near[0], draw: near[1], away: near[2] } } });
    expect(blended.status).toBe('OPEN');
    expect(blended.external.used).toBe(true);
    const far = priceMatch({ model, homeId: 'T0', awayId: 'T1', external: { matchResult: { home: 1.1, draw: 9, away: 20 } } });
    if (fair[0] < 0.75) {
      expect(far.status).toBe('SUSPENDED');
      expect(far.suspensionReason).toBe('MODEL_MARKET_DIVERGENCE');
    }
  });
  it('lambda calibration hits a 1X2 target', () => {
    const [h, a] = calibrateLambdas(1.3, 1.1, -0.05, { HOME: 0.5, AWAY: 0.25 });
    const o = outcomeProbs(scoreMatrix(h, a, -0.05));
    expect(o.HOME).toBeCloseTo(0.5, 3);
    expect(o.AWAY).toBeCloseTo(0.25, 3);
  });
  it('derived probabilities are coherent', () => {
    const m = deriveMarkets(scoreMatrix(1.5, 1.0, -0.05));
    const cs = m.find((x) => x.type === 'CORRECT_SCORE')!;
    expect(Object.values(cs.probs).reduce((a, b) => a + b)).toBeCloseTo(1, 10);
    const btts = m.find((x) => x.type === 'BOTH_TEAMS_TO_SCORE')!;
    expect(btts.probs.YES + btts.probs.NO).toBeCloseTo(1, 12);
  });
});

describe('metrics', () => {
  it('known values', () => {
    expect(brierScore([[1, 0, 0]], [0])).toBe(0);
    expect(brierScore([[1 / 3, 1 / 3, 1 / 3]], [0])).toBeCloseTo(2 / 3);
    expect(logLoss([[0.5, 0.25, 0.25]], [0])).toBeCloseTo(Math.log(2));
    expect(rankedProbabilityScore([[1, 0, 0]], [0])).toBe(0);
    const c = calibration([0.1, 0.1, 0.9, 0.9], [false, false, true, true], 10);
    expect(c.ece).toBeCloseTo(0.1);
    expect(() => brierScore([], [])).toThrow();
  });
});

describe('walk-forward backtest', () => {
  it('beats the base-rate baseline and is calibrated on data from the generating process', () => {
    const teams = league(20, 21);
    const matches = simulateLeague(teams, { seed: 99, start: new Date('2022-01-01'), rounds: 8 });
    const rep = walkForwardBacktest(matches, { warmup: 380, refitEvery: 40, minTeamMatches: 10 });
    expect(rep.n).toBeGreaterThan(1000);
    expect(rep.model.brier).toBeLessThan(rep.baseline.brier);
    expect(rep.model.logLoss).toBeLessThan(rep.baseline.logLoss);
    expect(rep.skillVsBaseline).toBeGreaterThan(0.02);
    expect(rep.model.ece).toBeLessThan(0.05);
    expect(rep.totals25.ece).toBeLessThan(0.06);
  }, 60_000);
});

describe('simulation', () => {
  it('sampleScore is deterministic for a seed', () => {
    expect(sampleScore(1.4, 1.1, -0.05, rng(5))).toEqual(sampleScore(1.4, 1.1, -0.05, rng(5)));
  });
});
