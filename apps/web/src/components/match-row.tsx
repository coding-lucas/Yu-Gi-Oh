'use client';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { formatDay, formatTime } from '@/lib/utils';
import type { MatchSummary } from '@/lib/types';
import { OddsButton } from './odds-button';
import { Badge } from './ui/badge';
import { TeamCrest } from './team-badge';

export function MatchRow({ m }: { m: MatchSummary }) {
  const locale = useLocale();
  const t = useTranslations();
  const finished = m.status === 'FINISHED';
  const open = m.mainMarket?.status === 'OPEN';
  return (
    <div className="flex flex-col gap-2 border-t border-line/70 px-3 py-3 first:border-t-0 sm:flex-row sm:items-center sm:gap-4">
      <Link href={`/match/${m.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <div className="w-12 shrink-0 text-center">
          {m.status === 'SCHEDULED' ? (
            <>
              <div className="text-sm font-bold tabular-nums text-fg">{formatTime(m.kickoffAt, locale)}</div>
              <div className="text-[10px] uppercase text-muted">{formatDay(m.kickoffAt, locale, undefined, { weekday: 'short' })}</div>
            </>
          ) : m.status === 'LIVE' ? (
            <Badge variant="danger">{t('common.live')}</Badge>
          ) : (
            <span className="text-[10px] font-semibold uppercase text-muted">{t(`status.${m.status}` as any)}</span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          {[{ team: m.home, g: m.homeGoals }, { team: m.away, g: m.awayGoals }].map(({ team, g }) => (
            <div key={team.id} className="flex items-center gap-2">
              <TeamCrest team={team} size={20} />
              <span className="truncate text-sm font-medium">{team.name}</span>
              {finished && <span className="ms-auto text-sm font-bold tabular-nums">{g}</span>}
            </div>
          ))}
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted rtl:rotate-180 sm:hidden" />
      </Link>
      <div className="flex items-center gap-1.5 sm:w-[300px]">
        {m.mainMarket && m.mainMarket.selections.length === 3 && !finished ? (
          m.mainMarket.selections.map((s) => (
            <OddsButton key={s.key} compact oddsId={s.oddsId} odds={s.odds} label={t(`markets.sel.${s.key}` as any)} matchId={m.id} marketKey="MATCH_RESULT" selection={s.key} home={m.home.name} away={m.away.name} kickoffAt={m.kickoffAt} disabled={!open} />
          ))
        ) : finished ? null : (
          <div className="flex h-10 flex-1 items-center justify-center rounded-xl border border-dashed border-line text-xs text-muted">{t('common.suspended')}</div>
        )}
        <Link href={`/match/${m.id}`} className="hidden h-10 shrink-0 items-center rounded-xl px-2 text-xs font-semibold text-brand hover:bg-elevated sm:flex">+{m.marketCount}</Link>
      </div>
    </div>
  );
}
