import { describe, expect, it } from 'vitest';
import { formatMoney, parseStake, formatOdds } from '../src/lib/utils';

describe('formatting', () => {
  it('formats minor units per locale', () => {
    expect(formatMoney('123456', 'pt')).toMatch(/1\.234,56/);
    expect(formatMoney('123456', 'en')).toMatch(/1,234\.56/);
    expect(formatMoney('123456', 'de')).toMatch(/1\.234,56/);
  });
  it('parses stakes with comma or dot', () => {
    expect(parseStake('10,5')).toBe('10.5');
    expect(parseStake('10.55')).toBe('10.55');
    expect(parseStake('10.555')).toBeNull();
    expect(parseStake('abc')).toBeNull();
  });
  it('formats odds with two decimals', () => {
    expect(formatOdds(2.1, 'en')).toBe('2.10');
    expect(formatOdds(2.1, 'pt')).toBe('2,10');
  });
});
