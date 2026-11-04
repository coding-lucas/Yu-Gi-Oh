'use client';
import { useEffect, useRef, useState } from 'react';
import { Lock, TrendingDown, TrendingUp } from 'lucide-react';
import { useLocale } from 'next-intl';
import { cn, formatOdds } from '@/lib/utils';
import { useBetSlip } from '@/stores/betslip';

export interface OddsButtonProps {
  oddsId: number;
  odds: number;
  label: string;
  matchId: string;
  marketKey: string;
  selection: string;
  home: string;
  away: string;
  kickoffAt: string;
  disabled?: boolean;
  compact?: boolean;
}

/** Odds cell: shows movement (flash + arrow), toggles the selection in the persistent bet slip. */
export function OddsButton(p: OddsButtonProps) {
  const locale = useLocale();
  const selected = useBetSlip((s) => s.items.some((i) => i.matchId === p.matchId && i.marketKey === p.marketKey && i.selection === p.selection));
  const toggle = useBetSlip((s) => s.toggle);
  const prev = useRef(p.odds);
  const [move, setMove] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (p.odds !== prev.current) {
      setMove(p.odds > prev.current ? 'up' : 'down');
      prev.current = p.odds;
      const t = setTimeout(() => setMove(null), 1600);
      return () => clearTimeout(t);
    }
  }, [p.odds]);

  return (
    <button
      type="button"
      disabled={p.disabled}
      aria-pressed={selected}
      onClick={() => toggle({ oddsId: p.oddsId, odds: p.odds, matchId: p.matchId, marketKey: p.marketKey, selection: p.selection, home: p.home, away: p.away, kickoffAt: p.kickoffAt })}
      className={cn(
        'group relative flex min-w-0 flex-1 items-center justify-between gap-1 rounded-xl border px-2.5 text-sm transition-all active:scale-[0.97]',
        p.compact ? 'h-10' : 'h-12',
        selected ? 'border-emerald bg-emerald/15 text-emerald' : 'border-line bg-elevated hover:border-brand/60',
        move === 'up' && 'animate-up',
        move === 'down' && 'animate-down',
        p.disabled && 'opacity-50',
      )}
    >
      <span className={cn('truncate text-xs', selected ? 'text-emerald' : 'text-muted')}>{p.label}</span>
      <span className="flex items-center gap-0.5 font-bold tabular-nums">
        {p.disabled ? <Lock className="h-3.5 w-3.5" /> : (
          <>
            {move === 'up' && <TrendingUp className="h-3 w-3 text-emerald" />}
            {move === 'down' && <TrendingDown className="h-3 w-3 text-danger" />}
            {formatOdds(p.odds, locale)}
          </>
        )}
      </span>
    </button>
  );
}
