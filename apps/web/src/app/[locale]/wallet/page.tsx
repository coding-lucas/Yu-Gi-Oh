'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useErrorMessage } from '@/lib/labels';
import { cn, formatDateTime, formatMoney, newIdempotencyKey, parseStake } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Tabs } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { RequireAuth } from '@/components/require-auth';
import { useWallet } from '@/components/providers';

const METHODS = ['PIX', 'CREDIT_CARD', 'DEBIT_CARD', 'BOLETO', 'BANK_TRANSFER', 'BTC'] as const;

export default function WalletPage() {
  return <RequireAuth><Wallet /></RequireAuth>;
}

function Wallet() {
  const t = useTranslations('wallet');
  const tc = useTranslations('common');
  const locale = useLocale();
  const qc = useQueryClient();
  const err = useErrorMessage();
  const wallet = useWallet(true);
  const [dir, setDir] = useState<'deposit' | 'withdraw'>('deposit');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('PIX');
  const [amount, setAmount] = useState('50');
  const [card, setCard] = useState('4242 4242 4242 4242');
  const [key, setKey] = useState(newIdempotencyKey());
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const statement = useQuery<any[]>({ queryKey: ['wallet', 'statement'], queryFn: () => api('/wallet/statement') });
  const payments = useQuery<any[]>({ queryKey: ['wallet', 'payments'], queryFn: () => api('/payments') });
  const methods = useQuery<{ method: string; sandbox: boolean; real: boolean }[]>({ queryKey: ['methods'], queryFn: () => api('/payments/methods') });

  const submit = useMutation({
    mutationFn: () => api(dir === 'deposit' ? '/payments/deposits' : '/payments/withdrawals', {
      method: 'POST',
      json: { amount: parseStake(amount), method, idempotencyKey: key, ...(dir === 'deposit' && method.includes('CARD') ? { card: { number: card } } : {}) },
    }),
    onSuccess: (r) => { setResult(r); setError(null); setKey(newIdempotencyKey()); qc.invalidateQueries({ queryKey: ['wallet'] }); },
    onError: (e) => { setError(err(e instanceof ApiError ? e.code : undefined)); if (e instanceof ApiError && e.status < 500) setKey(newIdempotencyKey()); },
  });
  const simulate = useMutation({
    mutationFn: (id: string) => api(`/payments/${id}/simulate`, { method: 'POST', json: { outcome: 'payment.succeeded' } }),
    onSuccess: () => { setResult(null); qc.invalidateQueries({ queryKey: ['wallet'] }); },
  });

  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[1fr_1.2fr]">
      <div className="space-y-4">
        <Card className="bg-gradient-to-br from-brand/25 via-surface to-emerald/20">
          <CardContent>
            <p className="text-xs uppercase tracking-widest text-muted">{tc('balance')}</p>
            <p className="mt-1 text-3xl font-extrabold tabular-nums">{wallet.data ? formatMoney(wallet.data.balance, locale, wallet.data.currency) : '…'}</p>
            <Badge variant="brand" className="mt-2">SANDBOX</Badge>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3">
            <Tabs value={dir} onChange={(v) => { setDir(v); setResult(null); }} items={[{ value: 'deposit', label: t('deposit') }, { value: 'withdraw', label: t('withdraw') }]} />
            <div className="grid grid-cols-3 gap-1.5">
              {METHODS.map((m) => (
                <button key={m} onClick={() => setMethod(m)} className={cn('rounded-xl border px-2 py-2 text-xs font-semibold', method === m ? 'border-emerald bg-emerald/10 text-emerald' : 'border-line text-muted')}>{t(m)}</button>
              ))}
            </div>
            <Field label={t('amount')}><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            {dir === 'deposit' && method.includes('CARD') && <Field label={t('cardNumber')}><Input value={card} onChange={(e) => setCard(e.target.value)} /></Field>}
            <Button className="w-full" variant="emerald" size="lg" disabled={submit.isPending || !parseStake(amount)} onClick={() => submit.mutate()}>{dir === 'deposit' ? t('deposit') : t('withdraw')}</Button>
            {error && <p className="rounded-lg bg-danger/10 p-2 text-xs text-danger">{error}</p>}
            {result?.payment && (
              <div className="space-y-2 rounded-xl border border-line bg-bg p-3 text-xs">
                <p>{t(dir === 'deposit' ? 'deposit' : 'withdraw')}: <b>{t(`pstatus.${result.payment.status}` as any)}</b></p>
                {result.instructions && (
                  <>
                    <p className="font-semibold">{t('instructions')}</p>
                    {Object.entries(result.instructions).map(([k, v]) => <p key={k} className="break-all font-mono text-muted">{k}: {String(v)}</p>)}
                  </>
                )}
                {result.payment.status === 'PENDING' && dir === 'deposit' && <Button size="sm" variant="outline" onClick={() => simulate.mutate(result.payment.id)}>{t('simulate')}</Button>}
              </div>
            )}
            <p className="text-[11px] text-muted">{t('sandboxNote')}</p>
            {methods.data && methods.data.every((m) => !m.real) && <p className="text-[11px] text-warn">{t('realUnavailable')}</p>}
          </CardContent>
        </Card>
      </div>
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>{t('statement')}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-line/60">
              {statement.data?.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{t(`tx.${s.type}` as any)}</p>
                    <p className="text-xs text-muted">{formatDateTime(s.at, locale)}</p>
                  </div>
                  <div className="text-end">
                    <p className={cn('font-bold tabular-nums', BigInt(s.amount) > 0n ? 'text-emerald' : 'text-fg')}>{BigInt(s.amount) > 0n ? '+' : ''}{formatMoney(s.amount, locale)}</p>
                    <p className="text-xs tabular-nums text-muted">{formatMoney(s.balanceAfter, locale)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('payments')}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-line/60">
              {payments.data?.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="font-medium">{t(p.direction === 'DEPOSIT' ? 'deposit' : 'withdraw')} · {t(p.method)}</span>
                  <Badge variant={p.status === 'COMPLETED' ? 'emerald' : p.status === 'FAILED' || p.status === 'CANCELLED' ? 'danger' : 'warn'}>{t(`pstatus.${p.status}` as any)}</Badge>
                  <span className="ms-auto font-bold tabular-nums">{formatMoney(p.amount, locale)}</span>
                  {p.status === 'PENDING' && p.direction === 'DEPOSIT' && <Button size="sm" variant="ghost" onClick={() => simulate.mutate(p.id)}>{t('simulate')}</Button>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
