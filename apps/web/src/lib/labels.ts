'use client';
import { useMessages, useTranslations } from 'next-intl';

/** Localised market and selection labels from canonical keys. */
export function useMarketLabels() {
  const t = useTranslations('markets');
  const market = (key: string) => {
    const [type, line] = key.split('@');
    return t(type as any, { line: line ?? '' });
  };
  const selection = (marketKey: string, sel: string) => {
    if (/^\d+-\d+$/.test(sel)) return sel;
    const [, line] = marketKey.split('@');
    const base = t(`sel.${sel}` as any);
    return line && (sel === 'OVER' || sel === 'UNDER') ? `${base} ${line}` : base;
  };
  return { market, selection };
}

export function useErrorMessage() {
  const t = useTranslations('errors');
  const messages = useMessages() as any;
  return (code?: string) => (code && messages?.errors?.[code] ? t(code as any) : t('GENERIC'));
}
