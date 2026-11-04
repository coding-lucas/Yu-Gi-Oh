'use client';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Star } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { cn, formatDay, userTz } from '@/lib/utils';
import type { MatchList, MatchSummary } from '@/lib/types';
import { Card } from './ui/card';
import { MatchRow } from './match-row';
import { Tabs } from './ui/tabs';
import { BetSlipPanel } from './bet-slip';
import { FeaturedStrip } from './featured';
import { useMe } from './providers';

type Filter = 'today' | 'tomorrow' | 'week' | 'live' | 'date';

function ymdAdd(base: Date, n: number) {
  const d = new Date(base.getTime() + n * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: userTz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function MatchBoard({ initialFilter = 'today', showFeatured = true }: { initialFilter?: Filter; showFeatured?: boolean }) {
  const t = useTranslations();
  const locale = useLocale();
  const { data: me } = useMe();
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [date, setDate] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [competition, setCompetition] = useState<string | null>(null);
  const [favorites, setFavorites] = useState(false);
  const tz = userTz();
  const q = useQuery<MatchList>({
    queryKey: ['matches', filter, date, competition, favorites, tz],
    queryFn: () => api(`/matches?filter=${filter}&tz=${encodeURIComponent(tz)}${date ? `&date=${date}` : ''}${competition ? `&competition=${competition}` : ''}${favorites ? '&favorites=1' : ''}`),
    refetchInterval: 60_000,
  });
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => ymdAdd(new Date(), i + weekOffset * 7)), [weekOffset]);
  const comps = useQuery<{ slug: string; name: string; region: string }[]>({ queryKey: ['competitions'], queryFn: () => api('/competitions'), staleTime: 600_000 });

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1 space-y-4">
        {showFeatured && filter !== 'live' && <FeaturedStrip />}
        <div className="space-y-2">
          <Tabs<Filter>
            value={filter}
            onChange={(v) => { setFilter(v); setDate(null); }}
            items={[
              { value: 'today', label: t('home.today') },
              { value: 'tomorrow', label: t('home.tomorrow') },
              { value: 'week', label: t('home.week') },
              { value: 'live', label: t('common.live') },
            ]}
          />
          <div className="flex items-center gap-1">
            <button aria-label={t('home.prevWeek')} onClick={() => setWeekOffset((w) => w - 1)} className="rounded-lg p-2 text-muted hover:bg-elevated"><ChevronLeft className="h-4 w-4 rtl:rotate-180" /></button>
            <div className="flex flex-1 gap-1 overflow-x-auto no-scrollbar">
              {days.map((d) => (
                <button key={d} onClick={() => { setFilter('date'); setDate(d); }} className={cn('shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium', filter === 'date' && date === d ? 'border-brand bg-brand/15 text-fg' : 'border-line text-muted hover:text-fg')}>
                  {formatDay(`${d}T12:00:00Z`, locale, 'UTC')}
                </button>
              ))}
            </div>
            <button aria-label={t('home.nextWeek')} onClick={() => setWeekOffset((w) => w + 1)} className="rounded-lg p-2 text-muted hover:bg-elevated"><ChevronRight className="h-4 w-4 rtl:rotate-180" /></button>
          </div>
          <div className="flex gap-1 overflow-x-auto no-scrollbar">
            <button onClick={() => setCompetition(null)} className={cn('shrink-0 rounded-full border px-3 py-1 text-xs', !competition ? 'border-emerald text-emerald' : 'border-line text-muted')}>{t('common.all')}</button>
            {me && (
              <button onClick={() => setFavorites((f) => !f)} className={cn('flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs', favorites ? 'border-warn text-warn' : 'border-line text-muted')}>
                <Star className="h-3 w-3" />{t('home.favorites')}
              </button>
            )}
            {comps.data?.map((c) => (
              <button key={c.slug} onClick={() => setCompetition(competition === c.slug ? null : c.slug)} className={cn('shrink-0 rounded-full border px-3 py-1 text-xs', competition === c.slug ? 'border-emerald text-emerald' : 'border-line text-muted')}>{c.name}</button>
            ))}
          </div>
        </div>

        {q.isLoading ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-surface" />)}</div>
        ) : q.isError ? (
          <Card className="p-6 text-center text-sm text-muted">{t('common.error')} <button className="text-brand" onClick={() => q.refetch()}>{t('common.retry')}</button></Card>
        ) : q.data!.groups.length === 0 ? (
          <Card className="p-10 text-center text-sm text-muted">{t('home.noMatches')}</Card>
        ) : (
          q.data!.groups.map((g, i) => (
            <section key={g.competition.id}>
              {(i === 0 || q.data!.groups[i - 1].competition.region !== g.competition.region) && g.competition.region === 'BRAZIL' && (
                <h2 className="mb-2 mt-1 text-xs font-bold uppercase tracking-widest text-emerald">{t('home.brazil')}</h2>
              )}
              <Card className="overflow-hidden">
                <header className="flex items-center gap-2 bg-elevated/60 px-3 py-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{g.competition.country}</span>
                  <span className="text-sm font-bold">{g.competition.name}</span>
                  <FavoriteButton kind="COMPETITION" id={g.competition.id} />
                  <span className="ms-auto text-xs text-muted">{g.matches.length}</span>
                </header>
                {g.matches.map((m: MatchSummary) => <MatchRow key={m.id} m={m} />)}
              </Card>
            </section>
          ))
        )}
      </div>
      <BetSlipPanel />
    </div>
  );
}

export function FavoriteButton({ kind, id }: { kind: 'TEAM' | 'COMPETITION'; id: string }) {
  const { data: me } = useMe();
  const favs = useQuery<{ kind: string; refId: string }[]>({ queryKey: ['favorites'], queryFn: () => api('/favorites'), enabled: !!me });
  const on = favs.data?.some((f) => f.kind === kind && f.refId === id);
  if (!me) return null;
  return (
    <button aria-label="favorite" aria-pressed={on} onClick={async () => { await api(`/favorites/${kind}/${id}`, { method: 'POST' }); favs.refetch(); }} className="rounded p-1 text-muted hover:text-warn">
      <Star className={cn('h-3.5 w-3.5', on && 'fill-warn text-warn')} />
    </button>
  );
}
