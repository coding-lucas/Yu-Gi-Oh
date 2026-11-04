'use client';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { newIdempotencyKey } from '@/lib/utils';

export interface SlipItem {
  oddsId: number;
  odds: number; // price shown to the player when added / last accepted
  currentOdds: number; // latest known price
  matchId: string;
  marketKey: string;
  selection: string;
  home: string;
  away: string;
  kickoffAt: string;
  suspended?: boolean;
  history: { odds: number; at: number }[];
  stake: string; // used in singles mode
}

interface SlipState {
  items: SlipItem[];
  mode: 'SINGLE' | 'MULTIPLE';
  multiStake: string;
  acceptHigher: boolean;
  open: boolean;
  submissionKey: string; // idempotency key reused across retries of the same submission
  toggle: (i: Omit<SlipItem, 'currentOdds' | 'history' | 'stake'>) => void;
  remove: (oddsId: number) => void;
  clear: () => void;
  setMode: (m: 'SINGLE' | 'MULTIPLE') => void;
  setStake: (oddsId: number, v: string) => void;
  setMultiStake: (v: string) => void;
  setAcceptHigher: (v: boolean) => void;
  setOpen: (v: boolean) => void;
  /** reconcile with fresh market data (new odds id/price or suspension) */
  updatePrices: (matchId: string, markets: { key: string; status: string; selections: { key: string; oddsId: number; odds: number }[] }[]) => void;
  acceptChanges: () => void;
  newSubmission: () => void;
}

export const useBetSlip = create<SlipState>()(
  persist(
    (set) => ({
      items: [],
      mode: 'SINGLE',
      multiStake: '10',
      acceptHigher: false,
      open: false,
      submissionKey: newIdempotencyKey(),
      toggle: (i) =>
        set((s) => {
          if (s.items.some((x) => x.oddsId === i.oddsId)) return { items: s.items.filter((x) => x.oddsId !== i.oddsId) };
          // same market of the same match: replace the selection (only one outcome per market)
          const items = s.items.filter((x) => !(x.matchId === i.matchId && x.marketKey === i.marketKey));
          const next = [...items, { ...i, currentOdds: i.odds, history: [{ odds: i.odds, at: Date.now() }], stake: '10' }];
          return { items: next, mode: next.length > 1 && s.items.length <= 1 ? 'MULTIPLE' : s.mode, submissionKey: newIdempotencyKey() };
        }),
      remove: (oddsId) => set((s) => ({ items: s.items.filter((x) => x.oddsId !== oddsId), submissionKey: newIdempotencyKey() })),
      clear: () => set({ items: [], submissionKey: newIdempotencyKey() }),
      setMode: (mode) => set({ mode, submissionKey: newIdempotencyKey() }),
      setStake: (oddsId, v) => set((s) => ({ items: s.items.map((x) => (x.oddsId === oddsId ? { ...x, stake: v } : x)), submissionKey: newIdempotencyKey() })),
      setMultiStake: (multiStake) => set({ multiStake, submissionKey: newIdempotencyKey() }),
      setAcceptHigher: (acceptHigher) => set({ acceptHigher }),
      setOpen: (open) => set({ open }),
      updatePrices: (matchId, markets) =>
        set((s) => ({
          items: s.items.map((it) => {
            if (it.matchId !== matchId) return it;
            const m = markets.find((x) => x.key === it.marketKey);
            const sel = m?.selections.find((x) => x.key === it.selection);
            if (!m || !sel) return { ...it, suspended: true };
            const changed = sel.odds !== it.currentOdds;
            return {
              ...it,
              oddsId: sel.oddsId,
              currentOdds: sel.odds,
              suspended: m.status !== 'OPEN',
              history: changed ? [...it.history, { odds: sel.odds, at: Date.now() }].slice(-10) : it.history,
            };
          }),
        })),
      acceptChanges: () => set((s) => ({ items: s.items.map((x) => ({ ...x, odds: x.currentOdds })), submissionKey: newIdempotencyKey() })),
      newSubmission: () => set({ submissionKey: newIdempotencyKey() }),
    }),
    { name: 'athosbet-slip', storage: createJSONStorage(() => localStorage), partialize: (s) => ({ items: s.items, mode: s.mode, multiStake: s.multiStake, acceptHigher: s.acceptHigher }) },
  ),
);

export function combinedOdds(items: SlipItem[]) {
  return items.reduce((p, x) => p * x.currentOdds, 1);
}
