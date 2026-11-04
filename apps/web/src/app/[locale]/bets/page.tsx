'use client';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useMarketLabels } from '@/lib/labels';
import { cn, formatDateTime, formatMoney, formatOdds } from '@/lib/utils';
import type { Bet } from '@/lib/types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs } from '@/components/ui/tabs';
import { RequireAuth } from '@/components/require-auth';

const tone = { WON: 'emerald', LOST: 'danger', VOID: 'default', OPEN: 'brand', PENDING: 'default' } as const;

export default function BetsPage() {
  return <RequireAuth><Bets /></RequireAuth>;
}

function Bets() {
  const t = useTranslations('bets');
  const ts = useTranslations('status');
  const locale = useLocale();
  const labels = useMarketLabels();
  const [tab, setTab] = useState<'OPEN' | 'SETTLED'>('OPEN');
  const q = useQuery<Bet[]>({ queryKey: ['bets', tab], queryFn: () => api(`/bets?status=${tab}`), refetchInterval: 30_000 });
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <Tabs value={tab} onChange={setTab} items={[{ value: 'OPEN', label: t('open') }, { value: 'SETTLED', label: t('settled') }]} />
      {q.data?.length === 0 && <Card className="p-10 text-center text-sm text-muted">{t('none')}</Card>}
      {q.data?.map((b) => (
        <Card key={b.id} className="overflow-hidden">
          <header className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-xs">
            <Badge variant={tone[b.status]}>{t(b.status)}</Badge>
            <span className="font-semibold">{b.type === 'MULTIPLE' ? `${b.legs.length}×` : ''}</span>
            <span className="text-muted">{t('code')} <b className="font-mono text-fg">{b.code}</b></span>
            <span className="ms-auto text-muted">{formatDateTime(b.placedAt, locale)}</span>
          </header>
          <ul className="divide-y divide-line/60">
            {b.legs.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', l.result === 'WON' ? 'bg-emerald' : l.result === 'LOST' ? 'bg-danger' : l.result === 'VOID' ? 'bg-muted' : 'bg-brand')} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{labels.selection(l.marketKey, l.selection)} <span className="font-normal text-muted">· {labels.market(l.marketKey)}</span></p>
                  <p className="truncate text-xs text-muted">{l.home} – {l.away} · {l.score ?? ts(l.matchStatus as any)}</p>
                </div>
                <b className="tabular-nums">{formatOdds(l.odds, locale)}</b>
              </li>
            ))}
          </ul>
          <footer className="grid grid-cols-3 gap-2 bg-elevated/40 px-4 py-2.5 text-xs">
            <div><p className="text-muted">{t('stake')}</p><b className="tabular-nums">{formatMoney(b.stake, locale)}</b></div>
            <div><p className="text-muted">Odds</p><b className="tabular-nums">{formatOdds(b.combinedOdds, locale)}</b></div>
            <div className="text-end"><p className="text-muted">{b.status === 'OPEN' ? t('potential') : t('payout')}</p><b className={cn('tabular-nums', b.status === 'WON' && 'text-emerald')}>{formatMoney(b.payout ?? b.potentialPayout, locale)}</b></div>
          </footer>
          {b.settlementVersion > 1 && <p className="px-4 pb-2 text-[11px] text-warn">{t('resettled')}</p>}
        </Card>
      ))}
    </div>
  );
}
