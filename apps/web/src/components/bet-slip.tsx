'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, History, Ticket, Trash2, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useErrorMessage, useMarketLabels } from '@/lib/labels';
import { cn, formatMoney, formatOdds, parseStake } from '@/lib/utils';
import { combinedOdds, useBetSlip, type SlipItem } from '@/stores/betslip';
import { Link } from '@/i18n/navigation';
import { useMe, useWallet } from './providers';
import { Button, buttonVariants } from './ui/button';
import { Tabs } from './ui/tabs';

function toMinorStr(major: string) {
  const s = parseStake(major);
  if (!s) return 0;
  const [i, f = ''] = s.split('.');
  return Number(i) * 100 + Number((f + '00').slice(0, 2));
}

function SlipBody({ onDone }: { onDone?: () => void }) {
  const t = useTranslations('slip');
  const locale = useLocale();
  const labels = useMarketLabels();
  const errMsg = useErrorMessage();
  const qc = useQueryClient();
  const s = useBetSlip();
  const { data: me } = useMe();
  const wallet = useWallet(!!me);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [showHistory, setShowHistory] = useState<number | null>(null);

  const sameMatch = useMemo(() => new Set(s.items.map((i) => i.matchId)).size !== s.items.length, [s.items]);
  const mode = s.items.length < 2 ? 'SINGLE' : s.mode;
  const changed = s.items.some((i) => i.odds !== i.currentOdds);
  const suspended = s.items.some((i) => i.suspended);
  const totalStake = mode === 'MULTIPLE' ? toMinorStr(s.multiStake) : s.items.reduce((a, i) => a + toMinorStr(i.stake), 0);
  const potential = mode === 'MULTIPLE'
    ? Math.floor(toMinorStr(s.multiStake) * combinedOdds(s.items))
    : s.items.reduce((a, i) => a + Math.floor(toMinorStr(i.stake) * i.currentOdds), 0);
  const balance = wallet.data ? Number(wallet.data.balance) : null;
  const insufficient = balance !== null && totalStake > balance;

  const place = useMutation({
    mutationFn: async () => {
      const policy = s.acceptHigher ? 'HIGHER' : 'NONE';
      if (mode === 'MULTIPLE') {
        return [await api('/bets', { method: 'POST', json: { legs: s.items.map((i) => ({ oddsId: i.oddsId, odds: i.odds })), stake: parseStake(s.multiStake), idempotencyKey: s.submissionKey, oddsPolicy: policy } })];
      }
      const out = [];
      for (const i of s.items) {
        const b = await api('/bets', { method: 'POST', json: { legs: [{ oddsId: i.oddsId, odds: i.odds }], stake: parseStake(i.stake), idempotencyKey: `${s.submissionKey}:${i.matchId}:${i.marketKey}`, oddsPolicy: policy } });
        out.push(b);
        // remove placed singles immediately so a later failure never re-submits them
        useBetSlip.setState((st) => ({ items: st.items.filter((x) => x.oddsId !== i.oddsId) }));
      }
      return out;
    },
    onSuccess: (bets: any[]) => {
      setMessage({ kind: 'ok', text: t('placed', { code: bets.map((b) => b.code).join(', ') }) });
      s.clear();
      qc.invalidateQueries({ queryKey: ['wallet'] });
      qc.invalidateQueries({ queryKey: ['bets'] });
      onDone?.();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ODDS_CHANGED') {
        const changes = (e.details?.changes ?? []) as { oddsId: number; currentK: number; currentOddsId: number }[];
        useBetSlip.setState((st) => ({
          items: st.items.map((i) => {
            const c = changes.find((x) => x.oddsId === i.oddsId);
            return c ? { ...i, oddsId: c.currentOddsId, currentOdds: c.currentK / 1000, history: [...i.history, { odds: c.currentK / 1000, at: Date.now() }] } : i;
          }),
        }));
      }
      setMessage({ kind: 'err', text: errMsg(e instanceof ApiError ? e.code : undefined) });
      if (!(e instanceof ApiError) || e.status >= 500) return; // keep key → safe retry
      s.newSubmission();
    },
  });

  useEffect(() => {
    if (message?.kind === 'ok') {
      const tm = setTimeout(() => setMessage(null), 6000);
      return () => clearTimeout(tm);
    }
  }, [message]);

  if (s.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm text-muted">
        <Ticket className="h-10 w-10 text-line" />
        {message?.kind === 'ok' ? <p className="flex items-center gap-2 text-emerald"><CheckCircle2 className="h-4 w-4" />{message.text}</p> : t('empty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {s.items.length > 1 && (
        <Tabs value={mode} onChange={s.setMode} items={[{ value: 'SINGLE', label: t('single') }, { value: 'MULTIPLE', label: t('multiple') }]} />
      )}
      <ul className="flex flex-col gap-2">
        {s.items.map((i: SlipItem) => {
          const moved = i.odds !== i.currentOdds;
          return (
            <li key={`${i.matchId}-${i.marketKey}`} className={cn('rounded-xl border bg-bg p-3', i.suspended ? 'border-warn/60' : moved ? 'border-brand/70' : 'border-line')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{labels.selection(i.marketKey, i.selection)} <span className="font-normal text-muted">· {labels.market(i.marketKey)}</span></p>
                  <p className="truncate text-xs text-muted">{i.home} – {i.away}</p>
                </div>
                <div className="flex items-center gap-1">
                  <span className={cn('rounded-lg px-2 py-1 text-sm font-bold tabular-nums', moved ? (i.currentOdds > i.odds ? 'bg-emerald/15 text-emerald' : 'bg-danger/15 text-danger') : 'bg-elevated')}>
                    {moved && <s className="me-1 font-normal opacity-60">{formatOdds(i.odds, locale)}</s>}
                    {formatOdds(i.currentOdds, locale)}
                  </span>
                  <button aria-label="history" onClick={() => setShowHistory(showHistory === i.oddsId ? null : i.oddsId)} className="rounded-lg p-1.5 text-muted hover:bg-elevated"><History className="h-4 w-4" /></button>
                  <button aria-label="remove" onClick={() => s.remove(i.oddsId)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger"><X className="h-4 w-4" /></button>
                </div>
              </div>
              {showHistory === i.oddsId && (
                <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-muted">
                  {i.history.map((h, k) => <span key={k} className="rounded bg-elevated px-1.5 py-0.5 tabular-nums">{formatOdds(h.odds, locale)}</span>)}
                </div>
              )}
              {i.suspended && <p className="mt-2 flex items-center gap-1 text-xs text-warn"><AlertTriangle className="h-3.5 w-3.5" />{t('unavailable')}</p>}
              {mode === 'SINGLE' && (
                <div className="mt-2 flex items-center gap-2">
                  <input inputMode="decimal" value={i.stake} onChange={(e) => s.setStake(i.oddsId, e.target.value)} aria-label={t('stake')} className="h-10 w-28 rounded-lg border border-line bg-surface px-2 text-sm tabular-nums focus:border-brand focus:outline-none" />
                  <span className="ms-auto text-xs text-muted">{t('potential')}: <b className="text-fg">{formatMoney(Math.floor(toMinorStr(i.stake) * i.currentOdds), locale)}</b></span>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {mode === 'MULTIPLE' && sameMatch && <p className="flex items-center gap-2 rounded-lg bg-warn/10 p-2 text-xs text-warn"><AlertTriangle className="h-4 w-4 shrink-0" />{t('sameMatch')}</p>}

      <div className="space-y-2 rounded-xl bg-bg p-3 text-sm">
        {mode === 'MULTIPLE' && (
          <>
            <div className="flex justify-between"><span className="text-muted">{t('odds')}</span><b className="tabular-nums">{formatOdds(combinedOdds(s.items), locale)}</b></div>
            <div className="flex items-center justify-between gap-2"><span className="text-muted">{t('stake')}</span>
              <input inputMode="decimal" value={s.multiStake} onChange={(e) => s.setMultiStake(e.target.value)} aria-label={t('stake')} className="h-10 w-32 rounded-lg border border-line bg-surface px-2 text-end text-sm tabular-nums focus:border-brand focus:outline-none" />
            </div>
          </>
        )}
        <div className="flex justify-between"><span className="text-muted">{t('totalStake')}</span><b className="tabular-nums">{formatMoney(totalStake, locale)}</b></div>
        <div className="flex justify-between text-base"><span className="text-muted">{t('potential')}</span><b className="tabular-nums text-emerald">{formatMoney(potential, locale)}</b></div>
        <label className="flex items-center gap-2 pt-1 text-xs text-muted">
          <input type="checkbox" checked={s.acceptHigher} onChange={(e) => s.setAcceptHigher(e.target.checked)} className="accent-[rgb(var(--emerald))]" />
          {t('acceptHigher')}
        </label>
      </div>

      {message && <p role="status" className={cn('rounded-lg p-2 text-xs', message.kind === 'ok' ? 'bg-emerald/10 text-emerald' : 'bg-danger/10 text-danger')}>{message.text}</p>}

      <div className="flex gap-2">
        <Button variant="ghost" size="icon" aria-label={t('clear')} onClick={s.clear}><Trash2 className="h-4 w-4" /></Button>
        {!me ? (
          <Link href="/login" className={cn(buttonVariants({ size: 'lg' }), 'flex-1')}>{t('loginToBet')}</Link>
        ) : changed ? (
          <Button className="flex-1" size="lg" onClick={s.acceptChanges}>{t('acceptChanges')}</Button>
        ) : (
          <Button className="flex-1" size="lg" variant="emerald" disabled={place.isPending || suspended || insufficient || totalStake <= 0 || (mode === 'MULTIPLE' && sameMatch)} onClick={() => { setMessage(null); place.mutate(); }}>
            {place.isPending ? t('placing') : insufficient ? t('insufficient') : t('place')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Desktop: sticky side panel. */
export function BetSlipPanel() {
  const t = useTranslations('slip');
  const count = useBetSlip((s) => s.items.length);
  return (
    <aside className="sticky top-20 hidden max-h-[calc(100vh-6rem)] w-[340px] shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface lg:flex">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Ticket className="h-4 w-4 text-emerald" />
        <h2 className="text-sm font-bold">{t('title')}</h2>
        {count > 0 && <span className="ms-auto rounded-full bg-emerald px-2 text-xs font-bold text-bg">{count}</span>}
      </header>
      <div className="overflow-y-auto"><SlipBody /></div>
    </aside>
  );
}

/** Mobile: floating summary above the bottom navigation + bottom sheet. */
export function BetSlipSheet() {
  const t = useTranslations('slip');
  const locale = useLocale();
  const { items, open, setOpen } = useBetSlip();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <>
      {items.length > 0 && !open && (
        <button onClick={() => setOpen(true)} className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex items-center gap-3 rounded-2xl bg-emerald px-4 py-3 text-bg shadow-2xl shadow-emerald/20 lg:hidden">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-bg/20 text-sm font-extrabold">{items.length}</span>
          <span className="font-bold">{t('title')}</span>
          <span className="ms-auto font-extrabold tabular-nums">{formatOdds(combinedOdds(items), locale)}</span>
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-3xl border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
            <div className="sticky top-0 flex items-center gap-2 border-b border-line bg-surface px-4 py-3">
              <Ticket className="h-4 w-4 text-emerald" />
              <h2 className="text-sm font-bold">{t('title')}</h2>
              <span className="text-xs text-muted">{t('selections', { count: items.length })}</span>
              <button className="ms-auto rounded-lg p-1.5 hover:bg-elevated" onClick={() => setOpen(false)} aria-label="close"><ChevronDown className="h-5 w-5" /></button>
            </div>
            <SlipBody onDone={() => setTimeout(() => setOpen(false), 1500)} />
          </div>
        </div>
      )}
    </>
  );
}
