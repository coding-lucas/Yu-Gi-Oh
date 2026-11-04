'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useErrorMessage } from '@/lib/labels';
import { formatDateTime } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { RequireAuth } from '@/components/require-auth';
import { LanguageSwitcher } from '@/components/shell';
import { useMe } from '@/components/providers';

const LIMITS = ['depositDaily', 'depositWeekly', 'depositMonthly', 'lossDaily', 'lossWeekly', 'lossMonthly', 'maxStake'] as const;
const TZS = ['America/Sao_Paulo', 'America/Buenos_Aires', 'America/New_York', 'Europe/London', 'Europe/Lisbon', 'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'UTC'];
const toMajor = (v?: string | null) => (v ? (Number(v) / 100).toFixed(2) : '');

export default function AccountPage() {
  return <RequireAuth><Account /></RequireAuth>;
}

function Account() {
  const t = useTranslations('account');
  const tc = useTranslations('common');
  const locale = useLocale();
  const err = useErrorMessage();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const limits = useQuery<any>({ queryKey: ['limits'], queryFn: () => api('/account/limits') });
  const excl = useQuery<any>({ queryKey: ['exclusion'], queryFn: () => api('/account/exclusion') });
  const jur = useQuery<any>({ queryKey: ['jurisdiction'], queryFn: () => api('/account/jurisdiction') });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [mfa, setMfa] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const saveLimits = useMutation({
    mutationFn: () => api('/account/limits', { method: 'PATCH', json: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v === '' ? null : v])) }),
    onSuccess: () => { setDraft({}); setMsg('✓'); limits.refetch(); },
    onError: (e) => setMsg(err(e instanceof ApiError ? e.code : undefined)),
  });
  const exclude = useMutation({
    mutationFn: (b: { kind: string; days: number | null }) => api('/account/exclusion', { method: 'POST', json: b }),
    onSuccess: () => excl.refetch(),
  });
  const tz = useMutation({ mutationFn: (timezone: string) => api('/account/profile', { method: 'PATCH', json: { timezone } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });

  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t('profile')}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="font-semibold">{me?.displayName} <span className="font-normal text-muted">· {me?.email}</span></p>
          <Field label={tc('language')}><LanguageSwitcher className="h-11 rounded-xl border border-line px-3" /></Field>
          <Field label={t('timezone')}>
            <Select value={me?.timezone} onChange={(e) => tz.mutate(e.target.value)}>{TZS.map((z) => <option key={z}>{z}</option>)}</Select>
          </Field>
          {jur.data && (
            <div className="rounded-xl bg-bg p-3 text-xs text-muted">
              <p className="font-semibold text-fg">{t('jurisdiction')}: {jur.data.accountCountry} · {jur.data.account}</p>
              <p className="mt-1">{t('jurisdictionNote')}</p>
            </div>
          )}
          <div className="rounded-xl bg-bg p-3">
            <p className="mb-2 text-xs font-semibold">{t('mfa')}</p>
            {me?.mfaEnabled ? <p className="text-xs text-emerald">{t('mfaEnabled')}</p> : mfa ? (
              <div className="space-y-2 text-xs">
                <p className="break-all font-mono text-muted">{mfa.secret}</p>
                <div className="flex gap-2"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder="000000" /><Button onClick={async () => { await api('/auth/mfa/enable', { method: 'POST', json: { code } }); qc.invalidateQueries({ queryKey: ['me'] }); }}>{tc('confirm')}</Button></div>
              </div>
            ) : <Button size="sm" variant="outline" onClick={async () => setMfa(await api('/auth/mfa/setup', { method: 'POST' }))}>{t('mfaSetup')}</Button>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('limits')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted">{t('limitsHelp')}</p>
          <div className="grid grid-cols-2 gap-3">
            {LIMITS.map((k) => (
              <Field key={k} label={t(k)} hint={limits.data?.pending?.[k] !== undefined && limits.data?.pendingEffectiveAt ? t('pending', { date: formatDateTime(limits.data.pendingEffectiveAt, locale) }) : undefined}>
                <Input inputMode="decimal" placeholder="—" value={draft[k] ?? toMajor(limits.data?.[k])} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              </Field>
            ))}
          </div>
          {msg && <p className="text-xs text-muted">{msg}</p>}
          <Button onClick={() => saveLimits.mutate()} disabled={Object.keys(draft).length === 0}>{tc('save')}</Button>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>{t('exclusion')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {excl.data?.active ? (
            <p className="text-sm text-warn">{t('excludedUntil', { date: excl.data.active.endsAt ? formatDateTime(excl.data.active.endsAt, locale) : t('permanent') })}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {[1, 7, 30].map((d) => <Button key={d} variant="outline" size="sm" onClick={() => confirm(`${t('coolOff')}: ${t('days', { count: d })}?`) && exclude.mutate({ kind: 'COOL_OFF', days: d })}>{t('coolOff')} · {t('days', { count: d })}</Button>)}
              {[180, 365].map((d) => <Button key={d} variant="outline" size="sm" onClick={() => confirm(`${t('selfExclusion')}: ${t('days', { count: d })}?`) && exclude.mutate({ kind: 'SELF_EXCLUSION', days: d })}>{t('selfExclusion')} · {t('days', { count: d })}</Button>)}
              <Button variant="danger" size="sm" onClick={() => confirm(`${t('selfExclusion')}: ${t('permanent')}?`) && exclude.mutate({ kind: 'SELF_EXCLUSION', days: null })}>{t('selfExclusion')} · {t('permanent')}</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
