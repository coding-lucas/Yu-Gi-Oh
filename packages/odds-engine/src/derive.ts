import { CORRECT_SCORE_MAX, MarketType, TOTAL_GOALS_LINES, correctScoreSelections, marketKey } from '@athosbet/shared';
import { ScoreMatrix } from './poisson';

export interface FairMarket {
  key: string;
  type: MarketType;
  line: number | null;
  /** fair (no-margin) probabilities of each selection; sums to 1 */
  probs: Record<string, number>;
}

export function outcomeProbs(m: ScoreMatrix) {
  let H = 0, D = 0, A = 0;
  m.forEach((row, h) => row.forEach((p, a) => { if (h > a) H += p; else if (h === a) D += p; else A += p; }));
  return { HOME: H, DRAW: D, AWAY: A };
}

export function totalProb(m: ScoreMatrix, pred: (total: number) => boolean) {
  let s = 0;
  m.forEach((row, h) => row.forEach((p, a) => { if (pred(h + a)) s += p; }));
  return s;
}

/** Derives every catalogue market from a single score matrix — guarantees internal consistency. */
export function deriveMarkets(m: ScoreMatrix): FairMarket[] {
  const { HOME, DRAW, AWAY } = outcomeProbs(m);
  const out: FairMarket[] = [
    { key: marketKey('MATCH_RESULT'), type: 'MATCH_RESULT', line: null, probs: { HOME, DRAW, AWAY } },
    {
      key: marketKey('DOUBLE_CHANCE'), type: 'DOUBLE_CHANCE', line: null,
      // DC selections overlap; each is a binary event. probs here are P(win) per selection (sum = 2).
      probs: { HOME_DRAW: HOME + DRAW, HOME_AWAY: HOME + AWAY, DRAW_AWAY: DRAW + AWAY },
    },
    { key: marketKey('DRAW_NO_BET'), type: 'DRAW_NO_BET', line: null, probs: { HOME: HOME / (HOME + AWAY), AWAY: AWAY / (HOME + AWAY) } },
  ];
  let bothScore = 0;
  m.forEach((row, h) => row.forEach((p, a) => { if (h > 0 && a > 0) bothScore += p; }));
  out.push({ key: marketKey('BOTH_TEAMS_TO_SCORE'), type: 'BOTH_TEAMS_TO_SCORE', line: null, probs: { YES: bothScore, NO: 1 - bothScore } });
  for (const line of TOTAL_GOALS_LINES) {
    const over = totalProb(m, (t) => t > line);
    out.push({ key: marketKey('TOTAL_GOALS', line), type: 'TOTAL_GOALS', line, probs: { OVER: over, UNDER: 1 - over } });
  }
  const cs: Record<string, number> = {};
  for (const s of correctScoreSelections()) cs[s] = 0;
  m.forEach((row, h) => row.forEach((p, a) => {
    if (h <= CORRECT_SCORE_MAX && a <= CORRECT_SCORE_MAX) cs[`${h}-${a}`] += p;
    else cs[h > a ? 'OTHER_HOME' : h === a ? 'OTHER_DRAW' : 'OTHER_AWAY'] += p;
  }));
  out.push({ key: marketKey('CORRECT_SCORE'), type: 'CORRECT_SCORE', line: null, probs: cs });
  return out;
}
