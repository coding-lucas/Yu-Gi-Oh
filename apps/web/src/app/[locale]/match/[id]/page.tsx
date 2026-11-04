'use client';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Info } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { use, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useMarketLabels } from '@/lib/labels';
import { cn, formatDateTime, formatOdds } from '@/lib/utils';
import type { Market, MatchDetail } from '@/lib/types';
import { Link } from '@/i18n/navigation';
import { useMeta, useSocket } from '@/components/providers';
import { OddsButton } from '@/components/odds-button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { BetSlipPanel } from '@/components/bet-slip';
import { TeamCrest } from '@/components/team-badge';
import { FavoriteButton } from '@/components/match-board';
import { useBetSlip } from '@/stores/betslip';

function FormDots({ form }: { form: string[] }) {
  return (
    <div className="flex gap-1">
      {form.map((r, i) => (
        <span key={i} className={cn('flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold', r === 'W' ? 'bg-emerald/20 text-emerald' : r === 'D' ? 'bg-elevated text-muted' : 'bg-danger/20 text-danger')}>{r}</span>
      ))}
    </div>
  );
}

function MarketCard({ m, match }: { m: Market; match: MatchDetail }) {
  const labels = useMarketLabels();
  const open = m.status === 'OPEN';
  const cs = m.type === 'CORRECT_SCORE';
  return (
    <Card className="overflow-hidden">
      <header className="flex items-center justify-between px-3 py-2.5">
        <h3 className="text-sm font-bold">{labels.market(m.key)}</h3>
        {!open && <Badge variant="warn">{m.status}</Badge>}
      </header>
      <div className={cn('grid gap-1.5 px-3 pb-3', cs ? 'grid-cols-3 sm:grid-cols-5' : m.selections.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
        {m.selections.map((s) => (
          <OddsButton key={s.key} oddsId={s.oddsId} odds={s.odds} label={labels.selection(m.key, s.key)} matchId={match.id} marketKey={m.key} selection={s.key} home={match.home.name} away={match.away.name} kickoffAt={match.kickoffAt} disabled={!open} compact={cs} />
        ))}
      </div>
    </Card>
  );
}

export default function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations();
  const locale = useLocale();
  const socket = useSocket();
  const meta = useMeta();
  const updatePrices = useBetSlip((s) => s.updatePrices);
  const [showRules, setShowRules] = useState(false);
  const q = useQuery<MatchDetail>({ queryKey: ['match', id], queryFn: () => api(`/matches/${id}`), refetchInterval: 30_000 });

  useEffect(() => {
    if (!socket) return;
    socket.emit('watch', id);
    return () => { socket.emit('unwatch', id); };
  }, [socket, id]);
  useEffect(() => {
    if (q.data) updatePrices(id, q.data.markets);
  }, [q.data, id, updatePrices]);

  if (q.isLoading) return <div className="h-64 animate-pulse rounded-2xl bg-surface" />;
  if (!q.data) return <Card className="p-8 text-center text-muted">{t('common.error')}</Card>;
  const m = q.data;
  const totalGroups = m.markets.filter((x) => x.type === 'TOTAL_GOALS');
  const others = m.markets.filter((x) => x.type !== 'TOTAL_GOALS');
  const ext = m.model?.external?.probs;
  const fair = m.markets.find((x) => x.key === 'MATCH_RESULT');

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1 space-y-3">
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4 rtl:rotate-180" />{t('nav.home')}</Link>
        <Card className="overflow-hidden bg-gradient-to-br from-surface via-surface to-brand/10">
          <div className="flex items-center justify-between px-4 pt-3 text-xs text-muted">
            <span className="font-semibold uppercase tracking-wide">{m.competition.name}{m.round ? ` · ${m.round}` : ''}</span>
            <Badge variant={m.status === 'LIVE' ? 'danger' : m.status === 'SCHEDULED' ? 'brand' : 'default'}>{t(`status.${m.status}` as any)}</Badge>
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-5">
            {[m.home, null, m.away].map((tm, i) => tm ? (
              <div key={tm.id} className="flex flex-col items-center gap-2 text-center">
                <TeamCrest team={tm} size={56} />
                <span className="text-sm font-bold sm:text-base">{tm.name}</span>
                <FavoriteButton kind="TEAM" id={tm.id} />
                <FormDots form={i === 0 ? m.form.home : m.form.away} />
              </div>
            ) : (
              <div key="mid" className="text-center">
                {m.status === 'FINISHED' ? <div className="text-3xl font-extrabold tabular-nums">{m.homeGoals} – {m.awayGoals}</div> : <div className="text-lg font-bold text-muted">{t('common.vs')}</div>}
                <div className="mt-1 text-xs text-muted">{formatDateTime(m.kickoffAt, locale)}</div>
              </div>
            ))}
          </div>
          {m.model && m.model.status === 'OPEN' && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-xs text-muted">
              <span className="font-semibold text-fg">{t('match.model')}</span>
              <span>{t('match.expectedGoals')}: <b className="tabular-nums text-fg">{m.model.lambdaHome.toFixed(2)} – {m.model.lambdaAway.toFixed(2)}</b></span>
              {ext && fair && (
                <span>{t('match.comparison')}: <b className="tabular-nums text-fg">{['HOME', 'DRAW', 'AWAY'].map((k) => formatOdds(1 / ext[k], locale)).join(' / ')}</b></span>
              )}
            </div>
          )}
        </Card>

        {m.markets.length === 0 || m.model?.status === 'SUSPENDED' ? (
          <Card className="p-6 text-center text-sm text-muted">{m.model?.suspensionReason ? t('match.suspendedReason', { reason: m.model.suspensionReason }) : t('match.noMarkets')}</Card>
        ) : (
          <>
            {others.filter((x) => x.type !== 'CORRECT_SCORE').map((mk) => <MarketCard key={mk.id} m={mk} match={m} />)}
            {totalGroups.length > 0 && (
              <Card className="overflow-hidden">
                <header className="px-3 py-2.5"><h3 className="text-sm font-bold">{t('markets.TOTAL_GOALS', { line: '' })}</h3></header>
                <div className="space-y-1.5 px-3 pb-3">
                  {totalGroups.map((mk) => (
                    <div key={mk.id} className="grid grid-cols-[3rem_1fr_1fr] items-center gap-1.5">
                      <span className="text-center text-xs font-bold text-muted">{mk.line}</span>
                      {mk.selections.map((s) => (
                        <OddsButton key={s.key} compact oddsId={s.oddsId} odds={s.odds} label={t(`markets.sel.${s.key}` as any)} matchId={m.id} marketKey={mk.key} selection={s.key} home={m.home.name} away={m.away.name} kickoffAt={m.kickoffAt} disabled={mk.status !== 'OPEN'} />
                      ))}
                    </div>
                  ))}
                </div>
              </Card>
            )}
            {others.filter((x) => x.type === 'CORRECT_SCORE').map((mk) => <MarketCard key={mk.id} m={mk} match={m} />)}
          </>
        )}

        <Card>
          <button onClick={() => setShowRules((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-sm font-semibold"><Info className="h-4 w-4 text-brand" />{t('match.rulesTitle')}</button>
          {showRules && meta.data && (
            <div className="space-y-2 px-4 pb-4 text-xs leading-relaxed text-muted">
              {Object.entries(meta.data.marketRules).map(([k, v]) => <p key={k}><b className="text-fg">{k === 'GENERAL' ? '' : `${t(`markets.${k}` as any, { line: '' })}: `}</b>{locale === 'pt' ? v.pt : v.en}</p>)}
            </div>
          )}
        </Card>
      </div>
      <BetSlipPanel />
    </div>
  );
}
