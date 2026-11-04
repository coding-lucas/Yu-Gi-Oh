import { dcTau, poissonPmf } from './poisson';
import { HistoricalMatch } from './ratings';
import { rng, samplePoisson } from './random';

export interface TrueTeam {
  id: string;
  attack: number;
  defense: number;
}

/**
 * Generates a synthetic double round-robin league from known "true" parameters. Used to verify that
 * the fitting procedure recovers parameters and that the model is calibrated, and for demo history.
 */
export function simulateLeague(
  teams: TrueTeam[],
  opts: { seed: number; start: Date; mu?: number; home?: number; rounds?: number; daysBetweenRounds?: number },
): HistoricalMatch[] {
  const rand = rng(opts.seed);
  const mu = opts.mu ?? 0.3;
  const home = opts.home ?? 0.25;
  const out: HistoricalMatch[] = [];
  const rounds = opts.rounds ?? 2;
  let day = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < teams.length; i++) {
      for (let j = 0; j < teams.length; j++) {
        if (i === j) continue;
        if ((r % 2 === 0) !== (i < j)) continue; // alternate home/away per round
        const h = teams[i];
        const a = teams[j];
        const lh = Math.exp(mu + home + h.attack - a.defense);
        const la = Math.exp(mu + a.attack - h.defense);
        out.push({
          homeId: h.id,
          awayId: a.id,
          homeGoals: samplePoisson(lh, rand),
          awayGoals: samplePoisson(la, rand),
          date: new Date(opts.start.getTime() + day * 86_400_000 + out.length * 60_000),
        });
      }
      day += opts.daysBetweenRounds ?? 1;
    }
  }
  return out;
}

/** Samples a final score from the Dixon–Coles distribution (used by the sandbox result simulator). */
export function sampleScore(lh: number, la: number, rho: number, rand: () => number, maxGoals = 10): [number, number] {
  const u = rand();
  let c = 0;
  let total = 0;
  const cells: [number, number, number][] = [];
  for (let h = 0; h <= maxGoals; h++) for (let a = 0; a <= maxGoals; a++) {
    const p = poissonPmf(h, lh) * poissonPmf(a, la) * Math.max(0, dcTau(h, a, lh, la, rho));
    cells.push([h, a, p]);
    total += p;
  }
  for (const [h, a, p] of cells) {
    c += p / total;
    if (u <= c) return [h, a];
  }
  return [0, 0];
}
