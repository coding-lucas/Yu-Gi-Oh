export type MarginMethod = 'PROPORTIONAL' | 'POWER';

/**
 * Applies the bookmaker margin to a set of mutually-exclusive, exhaustive probabilities.
 * Returns implied probabilities summing to (1 + margin).
 *  - PROPORTIONAL: q_i = p_i·(1+m)
 *  - POWER: q_i = p_i^k with k<1 chosen so Σq = 1+m — loads more margin on long shots, which mirrors
 *    the favourite–longshot bias and limits exposure to outsiders.
 */
export function applyMargin(probs: number[], margin: number, method: MarginMethod = 'POWER'): number[] {
  if (margin < 0 || margin > 0.5) throw new Error(`Margin out of range: ${margin}`);
  const target = 1 + margin;
  if (method === 'PROPORTIONAL' || margin === 0) return probs.map((p) => p * target);
  let lo = 0.01, hi = 1;
  const sum = (k: number) => probs.reduce((s, p) => s + Math.pow(p, k), 0);
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (sum(mid) > target) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  return probs.map((p) => Math.pow(p, k));
}

/** Removes the margin from a bookmaker's decimal odds (proportional normalisation). */
export function devig(decimalOdds: number[], method: MarginMethod = 'PROPORTIONAL'): number[] {
  const implied = decimalOdds.map((o) => 1 / o);
  const s = implied.reduce((a, b) => a + b, 0);
  if (method === 'PROPORTIONAL') return implied.map((q) => q / s);
  let lo = 1, hi = 10;
  const f = (k: number) => implied.reduce((a, q) => a + Math.pow(q, k), 0);
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 1) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  return implied.map((q) => Math.pow(q, k));
}

export function overround(decimalOdds: number[]): number {
  return decimalOdds.reduce((a, o) => a + 1 / o, 0) - 1;
}

/**
 * Price ladder: odds are always rounded DOWN to the nearest tick so that rounding only ever
 * increases the margin (never offers a price above the computed one).
 */
const LADDER: [number, number][] = [
  [2, 0.01], [3, 0.02], [4, 0.05], [6, 0.1], [10, 0.2], [20, 0.5], [50, 1], [Infinity, 5],
];

export function roundToLadder(odds: number, minOdds = 1.01, maxOdds = 251): number {
  if (!Number.isFinite(odds)) return maxOdds;
  const capped = Math.min(Math.max(odds, minOdds), maxOdds);
  let floor = 1;
  for (const [upto, tick] of LADDER) {
    if (capped < upto) {
      const n = Math.floor((capped - floor) / tick + 1e-9);
      return Math.max(minOdds, Number((floor + n * tick).toFixed(2)));
    }
    floor = upto;
  }
  return capped;
}

export function probToOdds(q: number, minOdds = 1.01, maxOdds = 251): number {
  if (!(q > 0)) return maxOdds;
  return roundToLadder(1 / q, minOdds, maxOdds);
}
