/** Currency amounts are always integers in minor units (cents). Never use floats for money. */
export function toMinor(major: number | string, decimals = 2): bigint {
  const s = typeof major === 'number' ? major.toFixed(decimals) : major.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount ${major}`);
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  if (f.length > decimals) throw new Error(`Too many decimals in ${major}`);
  const v = BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return neg ? -v : v;
}
export function fromMinor(minor: bigint | string | number, decimals = 2): string {
  const v = BigInt(minor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const d = 10n ** BigInt(decimals);
  return `${neg ? '-' : ''}${abs / d}.${(abs % d).toString().padStart(decimals, '0')}`;
}
/** Sandbox play currency. Never convertible to real money. */
export const DEMO_CURRENCY = 'ATH';
