'use client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, ApiError } from '@/lib/api';
import type { User } from '@/lib/types';

const SocketCtx = createContext<Socket | null>(null);
export const useSocket = () => useContext(SocketCtx);

function RealtimeBridge({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [socket, setSocket] = useState<Socket | null>(null);
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_WS_URL || undefined;
    const s = io(url ?? '', { path: '/api/ws', withCredentials: true });
    s.on('board', () => qc.invalidateQueries({ queryKey: ['matches'] }));
    s.on('odds', (e: { matchId: string; markets: unknown }) => qc.setQueryData(['match', e.matchId], (old: any) => (old ? { ...old, markets: e.markets } : old)));
    s.on('match', () => qc.invalidateQueries({ queryKey: ['matches'] }));
    s.on('wallet', () => qc.invalidateQueries({ queryKey: ['wallet'] }));
    s.on('bet', () => qc.invalidateQueries({ queryKey: ['bets'] }));
    setSocket(s);
    return () => {
      s.close();
    };
  }, [qc]);
  return <SocketCtx.Provider value={socket}>{children}</SocketCtx.Provider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 } } }),
  );
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return (
    <QueryClientProvider client={qc}>
      <RealtimeBridge>{children}</RealtimeBridge>
    </QueryClientProvider>
  );
}

export function useMe() {
  return useQuery<User | null>({
    queryKey: ['me'],
    queryFn: () => api<User>('/auth/me').catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
    staleTime: 60_000,
  });
}

export function useWallet(enabled: boolean) {
  return useQuery<{ balance: string; currency: string; mode: string }>({ queryKey: ['wallet'], queryFn: () => api('/wallet'), enabled, refetchInterval: 60_000 });
}

export function useMeta() {
  return useQuery<{ dataProvider: string; synthetic: boolean; realMoney: boolean; marketRules: Record<string, { en: string; pt: string }> }>({ queryKey: ['meta'], queryFn: () => api('/meta'), staleTime: Infinity });
}
