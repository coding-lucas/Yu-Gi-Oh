import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { LOCALE_BCP47, type Locale } from '@athosbet/shared';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function bcp47(locale: string) {
  return LOCALE_BCP47[locale as Locale] ?? 'en-GB';
}

/** Money is transported as integer minor units (string). */
export function formatMoney(minor: string | number | bigint, locale: string, currency = 'ATH') {
  const v = Number(BigInt(minor)) / 100;
  try {
    return new Intl.NumberFormat(bcp47(locale), { style: 'currency', currency, currencyDisplay: 'code' }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}

export function formatOdds(o: number, locale: string) {
  return new Intl.NumberFormat(bcp47(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(o);
}

export function userTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function formatTime(d: string | Date, locale: string, tz = userTz()) {
  return new Intl.DateTimeFormat(bcp47(locale), { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(d));
}
export function formatDay(d: string | Date, locale: string, tz = userTz(), opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: '2-digit', month: 'short' }) {
  return new Intl.DateTimeFormat(bcp47(locale), { ...opts, timeZone: tz }).format(new Date(d));
}
export function formatDateTime(d: string | Date, locale: string, tz = userTz()) {
  return new Intl.DateTimeFormat(bcp47(locale), { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(d));
}

export function newIdempotencyKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Stake input (major units, locale-tolerant) → minor units string for the API. */
export function parseStake(input: string): string | null {
  const s = input.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return s;
}
