'use client';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { formatDay, formatTime } from '@/lib/utils';
import type { MatchSummary } from '@/lib/types';
import { Link } from '@/i18n/navigation';
import { matchHref } from '@/lib/routes';
import { OddsButton } from './odds-button';
import { TeamCrest } from './team-badge';

export function FeaturedStrip() {
  const t = useTranslations();
  const locale = useLocale();
  const q = useQuery<MatchSummary[]>({ queryKey: ['matches', 'featured'], queryFn: () => api('/matches/featured'), refetchInterval: 60_000 });
  if (!q.data?.length) return null;
  return (
    <section>
      <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-muted">{t('home.featured')}</h2>
      <div className="-mx-3 flex snap-x gap-3 overflow-x-auto px-3 pb-1 no-scrollbar">
        {q.data.map((m) => (
          <article key={m.id} className="w-[280px] shrink-0 snap-start rounded-2xl border border-line bg-gradient-to-br from-surface to-elevated p-3">
            <Link href={matchHref(m.id)} className="block">
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span className="truncate font-semibold uppercase tracking-wide">{m.competition.name}</span>
                <span className="tabular-nums">{formatDay(m.kickoffAt, locale)} · {formatTime(m.kickoffAt, locale)}</span>
              </div>
              <div className="my-3 space-y-1.5">
                {[m.home, m.away].map((tm) => (
                  <div key={tm.id} className="flex items-center gap-2 text-sm font-semibold"><TeamCrest team={tm} size={22} />{tm.name}</div>
                ))}
              </div>
            </Link>
            <div className="flex gap-1.5">
              {m.mainMarket?.selections.map((s) => (
                <OddsButton key={s.key} compact oddsId={s.oddsId} odds={s.odds} label={t(`markets.sel.${s.key}` as any)} matchId={m.id} marketKey="MATCH_RESULT" selection={s.key} home={m.home.name} away={m.away.name} kickoffAt={m.kickoffAt} />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
