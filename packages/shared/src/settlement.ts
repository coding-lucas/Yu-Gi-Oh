import { CORRECT_SCORE_MAX, MarketType } from './markets';

export type SelectionResult = 'WON' | 'LOST' | 'VOID';

export type MatchOutcome =
  | { kind: 'RESULT'; homeGoals: number; awayGoals: number }
  /** cancelled, abandoned or postponed beyond the 48h window */
  | { kind: 'VOID' };

/**
 * Settles a single selection against the official regular-time outcome.
 * Pure and deterministic — the same input always yields the same output, which makes
 * re-settlement after result corrections safe.
 */
export function settleSelection(
  type: MarketType,
  line: number | null,
  selection: string,
  outcome: MatchOutcome,
): SelectionResult {
  if (outcome.kind === 'VOID') return 'VOID';
  const { homeGoals: h, awayGoals: a } = outcome;
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) {
    throw new Error(`Invalid score ${h}-${a}`);
  }
  const res = h > a ? 'HOME' : h < a ? 'AWAY' : 'DRAW';
  const win = (b: boolean): SelectionResult => (b ? 'WON' : 'LOST');

  switch (type) {
    case 'MATCH_RESULT':
      assertSel(selection, ['HOME', 'DRAW', 'AWAY']);
      return win(selection === res);
    case 'DOUBLE_CHANCE':
      assertSel(selection, ['HOME_DRAW', 'HOME_AWAY', 'DRAW_AWAY']);
      return win(selection.split('_').includes(res));
    case 'DRAW_NO_BET':
      assertSel(selection, ['HOME', 'AWAY']);
      if (res === 'DRAW') return 'VOID';
      return win(selection === res);
    case 'BOTH_TEAMS_TO_SCORE':
      assertSel(selection, ['YES', 'NO']);
      return win((h > 0 && a > 0) === (selection === 'YES'));
    case 'TOTAL_GOALS': {
      assertSel(selection, ['OVER', 'UNDER']);
      if (line === null || !Number.isFinite(line)) throw new Error('TOTAL_GOALS requires a line');
      const total = h + a;
      if (total === line) return 'VOID';
      return win(selection === 'OVER' ? total > line : total < line);
    }
    case 'CORRECT_SCORE': {
      if (selection.startsWith('OTHER_')) {
        const inGrid = h <= CORRECT_SCORE_MAX && a <= CORRECT_SCORE_MAX;
        return win(!inGrid && selection === `OTHER_${res}`);
      }
      const m = /^(\d+)-(\d+)$/.exec(selection);
      if (!m) throw new Error(`Invalid correct score selection ${selection}`);
      return win(Number(m[1]) === h && Number(m[2]) === a);
    }
    default: {
      const never: never = type;
      throw new Error(`Unsupported market ${String(never)}`);
    }
  }
}

function assertSel(sel: string, allowed: string[]) {
  if (!allowed.includes(sel)) throw new Error(`Invalid selection ${sel}`);
}

export type BetResult = 'WON' | 'LOST' | 'VOID';

/** Odds are represented as integer thousandths (2.150 -> 2150) to keep money math exact. */
export const ODDS_SCALE = 1000n;

export function oddsToK(decimal: number): number {
  const k = Math.round(decimal * 1000);
  if (!Number.isFinite(k) || k < 1000) throw new Error(`Invalid decimal odds ${decimal}`);
  return k;
}
export function kToOdds(k: number): number {
  return k / 1000;
}

/**
 * Combined odds of a multiple (accumulator), truncated to thousandths.
 */
export function combinedOddsK(oddsK: number[]): bigint {
  let num = 1n;
  let den = 1n;
  for (const o of oddsK) {
    num *= BigInt(o);
    den *= ODDS_SCALE;
  }
  return (num * ODDS_SCALE) / den;
}

/** Potential payout (stake included), in minor units, truncated (never rounds in the player's favour beyond a cent). */
export function potentialPayout(stakeMinor: bigint, oddsK: number[]): bigint {
  let num = stakeMinor;
  let den = 1n;
  for (const o of oddsK) {
    num *= BigInt(o);
    den *= ODDS_SCALE;
  }
  return num / den;
}

/**
 * Settles a bet (single or multiple). Void legs count as odds 1.00.
 */
export function settleBet(
  stakeMinor: bigint,
  legs: { oddsK: number; result: SelectionResult }[],
): { result: BetResult; payoutMinor: bigint } {
  if (legs.length === 0) throw new Error('Bet without legs');
  if (legs.some((l) => l.result === 'LOST')) return { result: 'LOST', payoutMinor: 0n };
  const active = legs.filter((l) => l.result === 'WON');
  if (active.length === 0) return { result: 'VOID', payoutMinor: stakeMinor };
  return { result: 'WON', payoutMinor: potentialPayout(stakeMinor, active.map((l) => l.oddsK)) };
}
