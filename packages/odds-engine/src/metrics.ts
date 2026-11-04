/** Multi-class Brier score (mean of Σ_k (p_k − o_k)²). Lower is better; 0 = perfect. */
export function brierScore(preds: number[][], outcomes: number[]): number {
  check(preds, outcomes);
  let s = 0;
  preds.forEach((p, i) => p.forEach((pk, k) => { s += (pk - (outcomes[i] === k ? 1 : 0)) ** 2; }));
  return s / preds.length;
}

/** Mean negative log-likelihood of the realised outcome. */
export function logLoss(preds: number[][], outcomes: number[], eps = 1e-15): number {
  check(preds, outcomes);
  let s = 0;
  preds.forEach((p, i) => { s -= Math.log(Math.min(1 - eps, Math.max(eps, p[outcomes[i]]))); });
  return s / preds.length;
}

/** Ranked probability score for ordered outcomes (H, D, A). */
export function rankedProbabilityScore(preds: number[][], outcomes: number[]): number {
  check(preds, outcomes);
  let s = 0;
  preds.forEach((p, i) => {
    let cp = 0, co = 0, r = 0;
    for (let k = 0; k < p.length - 1; k++) {
      cp += p[k];
      co += outcomes[i] === k ? 1 : 0;
      r += (cp - co) ** 2;
    }
    s += r / (p.length - 1);
  });
  return s / preds.length;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  meanPredicted: number;
  observedFrequency: number;
}

/** Reliability diagram over binary events (one-vs-rest flattening for multi-class). */
export function calibration(probs: number[], hits: boolean[], bins = 10): { bins: CalibrationBin[]; ece: number } {
  if (probs.length !== hits.length) throw new Error('length mismatch');
  const out: CalibrationBin[] = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, count: 0, meanPredicted: 0, observedFrequency: 0 }));
  probs.forEach((p, i) => {
    const b = out[Math.min(bins - 1, Math.floor(p * bins))];
    b.count++;
    b.meanPredicted += p;
    b.observedFrequency += hits[i] ? 1 : 0;
  });
  let ece = 0;
  for (const b of out) {
    if (b.count) {
      b.meanPredicted /= b.count;
      b.observedFrequency /= b.count;
      ece += (b.count / probs.length) * Math.abs(b.meanPredicted - b.observedFrequency);
    }
  }
  return { bins: out, ece };
}

function check(preds: number[][], outcomes: number[]) {
  if (preds.length === 0 || preds.length !== outcomes.length) throw new Error('empty or mismatched predictions');
}
