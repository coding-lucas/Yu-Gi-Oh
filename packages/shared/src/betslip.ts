import { isValidSelection, parseMarketKey } from './markets';

export const MAX_LEGS = 20;

export interface SlipLeg {
  matchId: string;
  marketKey: string;
  selection: string;
}

export type SlipError =
  | { code: 'EMPTY' }
  | { code: 'TOO_MANY_LEGS'; max: number }
  | { code: 'DUPLICATE_SELECTION'; index: number }
  | { code: 'SAME_MATCH_IN_MULTIPLE'; matchId: string }
  | { code: 'INVALID_SELECTION'; index: number };

/**
 * Structural validation of a bet slip. Multiples may not contain more than one selection from the same
 * match: such legs are correlated and the independent-product price would be incorrect.
 */
export function validateSlip(legs: SlipLeg[]): SlipError[] {
  const errors: SlipError[] = [];
  if (legs.length === 0) return [{ code: 'EMPTY' }];
  if (legs.length > MAX_LEGS) errors.push({ code: 'TOO_MANY_LEGS', max: MAX_LEGS });
  const seen = new Set<string>();
  const matches = new Map<string, number>();
  legs.forEach((l, i) => {
    let ok = false;
    try {
      const { type, line } = parseMarketKey(l.marketKey);
      ok = isValidSelection(type, l.selection, line);
    } catch {
      ok = false;
    }
    if (!ok) errors.push({ code: 'INVALID_SELECTION', index: i });
    const k = `${l.matchId}|${l.marketKey}|${l.selection}`;
    if (seen.has(k)) errors.push({ code: 'DUPLICATE_SELECTION', index: i });
    seen.add(k);
    matches.set(l.matchId, (matches.get(l.matchId) ?? 0) + 1);
  });
  if (legs.length > 1) {
    for (const [matchId, n] of matches) if (n > 1) errors.push({ code: 'SAME_MATCH_IN_MULTIPLE', matchId });
  }
  return errors;
}

export type OddsChangePolicy = 'NONE' | 'HIGHER' | 'ANY';

/** Decides whether a price move between display and placement is acceptable for the player. */
export function acceptsPriceChange(policy: OddsChangePolicy, shownK: number, currentK: number): boolean {
  if (shownK === currentK) return true;
  if (policy === 'ANY') return true;
  if (policy === 'HIGHER') return currentK > shownK;
  return false;
}
