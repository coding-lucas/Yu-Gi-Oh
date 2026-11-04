import { describe, expect, it } from 'vitest';
import {
  settleSelection, settleBet, potentialPayout, combinedOddsK, oddsToK,
  validateSlip, acceptsPriceChange, gateBetting, ageInYears, toMinor, fromMinor,
  correctScoreSelections, parseMarketKey, marketKey, isValidSelection,
} from '../src';

const R = (h: number, a: number) => ({ kind: 'RESULT' as const, homeGoals: h, awayGoals: a });

describe('settleSelection', () => {
  it('1X2', () => {
    expect(settleSelection('MATCH_RESULT', null, 'HOME', R(2, 1))).toBe('WON');
    expect(settleSelection('MATCH_RESULT', null, 'DRAW', R(2, 1))).toBe('LOST');
    expect(settleSelection('MATCH_RESULT', null, 'DRAW', R(0, 0))).toBe('WON');
    expect(settleSelection('MATCH_RESULT', null, 'AWAY', R(0, 3))).toBe('WON');
  });
  it('double chance', () => {
    expect(settleSelection('DOUBLE_CHANCE', null, 'HOME_DRAW', R(1, 1))).toBe('WON');
    expect(settleSelection('DOUBLE_CHANCE', null, 'HOME_AWAY', R(1, 1))).toBe('LOST');
    expect(settleSelection('DOUBLE_CHANCE', null, 'DRAW_AWAY', R(0, 1))).toBe('WON');
  });
  it('draw no bet voids on draw', () => {
    expect(settleSelection('DRAW_NO_BET', null, 'HOME', R(2, 2))).toBe('VOID');
    expect(settleSelection('DRAW_NO_BET', null, 'AWAY', R(2, 3))).toBe('WON');
    expect(settleSelection('DRAW_NO_BET', null, 'HOME', R(2, 3))).toBe('LOST');
  });
  it('btts', () => {
    expect(settleSelection('BOTH_TEAMS_TO_SCORE', null, 'YES', R(1, 1))).toBe('WON');
    expect(settleSelection('BOTH_TEAMS_TO_SCORE', null, 'NO', R(1, 0))).toBe('WON');
    expect(settleSelection('BOTH_TEAMS_TO_SCORE', null, 'YES', R(3, 0))).toBe('LOST');
  });
  it('totals with half and integer lines', () => {
    expect(settleSelection('TOTAL_GOALS', 2.5, 'OVER', R(2, 1))).toBe('WON');
    expect(settleSelection('TOTAL_GOALS', 2.5, 'UNDER', R(2, 1))).toBe('LOST');
    expect(settleSelection('TOTAL_GOALS', 0.5, 'UNDER', R(0, 0))).toBe('WON');
    expect(settleSelection('TOTAL_GOALS', 3, 'OVER', R(2, 1))).toBe('VOID');
    expect(() => settleSelection('TOTAL_GOALS', null, 'OVER', R(2, 1))).toThrow();
  });
  it('correct score incl. other buckets', () => {
    expect(settleSelection('CORRECT_SCORE', null, '2-1', R(2, 1))).toBe('WON');
    expect(settleSelection('CORRECT_SCORE', null, '1-2', R(2, 1))).toBe('LOST');
    expect(settleSelection('CORRECT_SCORE', null, 'OTHER_HOME', R(5, 1))).toBe('WON');
    expect(settleSelection('CORRECT_SCORE', null, 'OTHER_HOME', R(4, 1))).toBe('LOST');
    expect(settleSelection('CORRECT_SCORE', null, 'OTHER_DRAW', R(5, 5))).toBe('WON');
    expect(settleSelection('CORRECT_SCORE', null, 'OTHER_AWAY', R(0, 7))).toBe('WON');
  });
  it('exactly one correct-score selection wins for any score', () => {
    for (let h = 0; h < 8; h++) for (let a = 0; a < 8; a++) {
      const won = correctScoreSelections().filter((s) => settleSelection('CORRECT_SCORE', null, s, R(h, a)) === 'WON');
      expect(won).toHaveLength(1);
    }
  });
  it('cancelled / abandoned matches void every market', () => {
    expect(settleSelection('MATCH_RESULT', null, 'HOME', { kind: 'VOID' })).toBe('VOID');
    expect(settleSelection('CORRECT_SCORE', null, '1-0', { kind: 'VOID' })).toBe('VOID');
  });
  it('rejects invalid input', () => {
    expect(() => settleSelection('MATCH_RESULT', null, 'X', R(1, 0))).toThrow();
    expect(() => settleSelection('MATCH_RESULT', null, 'HOME', R(-1, 0))).toThrow();
  });
});

describe('bet settlement & payouts', () => {
  it('single win payout truncates', () => {
    expect(potentialPayout(1000n, [2150])).toBe(2150n);
    expect(potentialPayout(333n, [1333])).toBe(443n); // 443.889 -> 443
  });
  it('multiple: void legs count as 1.00, any lost loses', () => {
    expect(settleBet(1000n, [{ oddsK: 2000, result: 'WON' }, { oddsK: 3000, result: 'VOID' }])).toEqual({ result: 'WON', payoutMinor: 2000n });
    expect(settleBet(1000n, [{ oddsK: 2000, result: 'WON' }, { oddsK: 3000, result: 'LOST' }])).toEqual({ result: 'LOST', payoutMinor: 0n });
    expect(settleBet(1000n, [{ oddsK: 2000, result: 'VOID' }])).toEqual({ result: 'VOID', payoutMinor: 1000n });
    expect(settleBet(1000n, [{ oddsK: 2000, result: 'WON' }, { oddsK: 1500, result: 'WON' }])).toEqual({ result: 'WON', payoutMinor: 3000n });
  });
  it('combined odds', () => {
    expect(combinedOddsK([2000, 1500])).toBe(3000n);
    expect(combinedOddsK([1333, 1333])).toBe(1776n);
    expect(oddsToK(2.15)).toBe(2150);
    expect(() => oddsToK(0.9)).toThrow();
  });
});

describe('bet slip validation', () => {
  it('rejects same-match legs in multiples and duplicates', () => {
    const errs = validateSlip([
      { matchId: 'm1', marketKey: 'MATCH_RESULT', selection: 'HOME' },
      { matchId: 'm1', marketKey: 'BOTH_TEAMS_TO_SCORE', selection: 'YES' },
    ]);
    expect(errs.map((e) => e.code)).toContain('SAME_MATCH_IN_MULTIPLE');
    expect(validateSlip([]).map((e) => e.code)).toEqual(['EMPTY']);
    const dup = validateSlip([
      { matchId: 'm1', marketKey: 'MATCH_RESULT', selection: 'HOME' },
      { matchId: 'm1', marketKey: 'MATCH_RESULT', selection: 'HOME' },
    ]);
    expect(dup.map((e) => e.code)).toContain('DUPLICATE_SELECTION');
  });
  it('validates selections', () => {
    expect(validateSlip([{ matchId: 'm', marketKey: 'TOTAL_GOALS@2.5', selection: 'OVER' }])).toEqual([]);
    expect(validateSlip([{ matchId: 'm', marketKey: 'TOTAL_GOALS', selection: 'OVER' }])[0].code).toBe('INVALID_SELECTION');
    expect(validateSlip([{ matchId: 'm', marketKey: 'NOPE', selection: 'OVER' }])[0].code).toBe('INVALID_SELECTION');
    expect(isValidSelection('MATCH_RESULT', 'HOME', 2.5)).toBe(false);
    expect(parseMarketKey(marketKey('TOTAL_GOALS', 2.5))).toEqual({ type: 'TOTAL_GOALS', line: 2.5 });
  });
  it('odds change policies', () => {
    expect(acceptsPriceChange('NONE', 2000, 2100)).toBe(false);
    expect(acceptsPriceChange('HIGHER', 2000, 2100)).toBe(true);
    expect(acceptsPriceChange('HIGHER', 2000, 1900)).toBe(false);
    expect(acceptsPriceChange('ANY', 2000, 1900)).toBe(true);
    expect(acceptsPriceChange('NONE', 2000, 2000)).toBe(true);
  });
});

describe('compliance gate', () => {
  const base = { mode: 'SANDBOX' as const, realMoneyEnabled: false, jurisdiction: 'SANDBOX_ONLY' as const, kycVerified: false, selfExcludedUntil: null, now: new Date('2026-01-01'), ageYears: 30 };
  it('allows sandbox in sandbox-only countries', () => expect(gateBetting(base)).toBeNull());
  it('blocks blocked jurisdictions even in sandbox', () => expect(gateBetting({ ...base, jurisdiction: 'BLOCKED' })).toBe('JURISDICTION_BLOCKED'));
  it('real money needs global flag, licence and KYC', () => {
    expect(gateBetting({ ...base, mode: 'REAL' })).toBe('REAL_MONEY_DISABLED');
    expect(gateBetting({ ...base, mode: 'REAL', realMoneyEnabled: true })).toBe('REAL_MONEY_NOT_LICENSED');
    expect(gateBetting({ ...base, mode: 'REAL', realMoneyEnabled: true, jurisdiction: 'LICENSED' })).toBe('KYC_REQUIRED');
    expect(gateBetting({ ...base, mode: 'REAL', realMoneyEnabled: true, jurisdiction: 'LICENSED', kycVerified: true })).toBeNull();
  });
  it('self exclusion and age', () => {
    expect(gateBetting({ ...base, selfExcludedUntil: new Date('2027-01-01') })).toBe('SELF_EXCLUDED');
    expect(gateBetting({ ...base, ageYears: 17 })).toBe('UNDERAGE');
    expect(ageInYears(new Date('2008-01-02'), new Date('2026-01-01'))).toBe(17);
    expect(ageInYears(new Date('2008-01-01'), new Date('2026-01-01'))).toBe(18);
  });
});

describe('money', () => {
  it('converts without floats', () => {
    expect(toMinor('10.5')).toBe(1050n);
    expect(toMinor(0.1 + 0.2)).toBe(30n);
    expect(fromMinor(1050n)).toBe('10.50');
    expect(fromMinor(-5n)).toBe('-0.05');
    expect(() => toMinor('1.234')).toThrow();
  });
});
