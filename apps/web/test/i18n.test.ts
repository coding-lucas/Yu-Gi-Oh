import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LOCALES, RTL_LOCALES, isRtl } from '@athosbet/shared';

const dir = path.resolve(__dirname, '../messages');
const load = (l: string) => JSON.parse(readFileSync(path.join(dir, `${l}.json`), 'utf8'));
function flat(o: any, p = ''): Record<string, string> {
  return Object.entries(o).reduce((acc, [k, v]) => (typeof v === 'object' ? { ...acc, ...flat(v, `${p}${k}.`) } : { ...acc, [`${p}${k}`]: v as string }), {});
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort();

describe('internationalisation', () => {
  const en = flat(load('en'));
  it('ships one message file per supported locale', () => {
    expect(readdirSync(dir).map((f) => f.replace('.json', '')).sort()).toEqual([...LOCALES].sort());
    expect(LOCALES).toHaveLength(11);
  });
  for (const l of LOCALES) {
    it(`${l}: same keys and placeholders as English, no empty strings`, () => {
      const m = flat(load(l));
      expect(Object.keys(m).sort()).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(m)) {
        expect(v.trim().length, `${l}:${k}`).toBeGreaterThan(0);
        expect(placeholders(v), `${l}:${k}`).toEqual(placeholders(en[k]));
      }
    });
  }
  it('non-English locales are actually translated', () => {
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      const m = flat(load(l));
      const same = Object.keys(en).filter((k) => m[k] === en[k] && en[k].length > 6);
      expect(same.length, `${l} untranslated: ${same.slice(0, 5)}`).toBeLessThan(8);
    }
  });
  it('Arabic is the only RTL locale', () => {
    expect(RTL_LOCALES).toEqual(['ar']);
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('he')).toBe(false);
  });
  it('compliance-critical messages exist everywhere', () => {
    for (const l of LOCALES) {
      const m = flat(load(l));
      for (const k of ['errors.JURISDICTION_BLOCKED', 'errors.SELF_EXCLUDED', 'common.sandbox', 'common.age', 'rg.body']) expect(m[k]).toBeTruthy();
    }
  });
});
