export function poissonPmf(k: number, lambda: number): number {
  if (k < 0) return 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Dixon & Coles (1997) low-score dependence correction τ(x, y).
 */
export function dcTau(x: number, y: number, lh: number, la: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Valid ρ interval so that every τ stays non-negative. */
export function rhoBounds(lh: number, la: number): [number, number] {
  return [Math.max(-1 / lh, -1 / la), Math.min(1 / (lh * la), 1)];
}

export type ScoreMatrix = number[][]; // [home][away]

/**
 * Joint score distribution under independent Poisson goals with the Dixon–Coles correction,
 * truncated at maxGoals and renormalised so that it sums to exactly 1.
 */
export function scoreMatrix(lh: number, la: number, rho = 0, maxGoals = 10): ScoreMatrix {
  if (!(lh > 0) || !(la > 0)) throw new Error(`Invalid expected goals ${lh}/${la}`);
  const [lo, hi] = rhoBounds(lh, la);
  const r = Math.min(Math.max(rho, lo), hi);
  const ph = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(k, lh));
  const pa = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(k, la));
  const m: ScoreMatrix = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    m.push([]);
    for (let a = 0; a <= maxGoals; a++) {
      const v = ph[h] * pa[a] * dcTau(h, a, lh, la, r);
      m[h].push(v);
      total += v;
    }
  }
  for (const row of m) for (let a = 0; a < row.length; a++) row[a] /= total;
  return m;
}
