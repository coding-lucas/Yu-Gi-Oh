'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { cn, formatDateTime, formatMoney } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs } from '@/components/ui/tabs';
import { RequireAuth } from '@/components/require-auth';
import { useMe } from '@/components/providers';

type Tab = 'overview' | 'matches' | 'risk' | 'payments' | 'users' | 'audit' | 'settings' | 'integrations';

export default function AdminPage() {
  return <RequireAuth staff><Admin /></RequireAuth>;
}

function Admin() {
  const t = useTranslations('admin');
  const { data: me } = useMe();
  const [tab, setTab] = useState<Tab>('overview');
  if (me && !me.sessionMfa) {
    return <Card className="mx-auto max-w-md p-8 text-center text-sm"><ShieldAlert className="mx-auto mb-3 h-8 w-8 text-warn" />{t('mfaRequired')}</Card>;
  }
  const tabs: Tab[] = ['overview', 'matches', 'risk', 'payments', 'users', 'audit', 'settings', 'integrations'];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-extrabold">{t('title')}</h1>
      <Tabs value={tab} onChange={setTab} items={tabs.map((v) => ({ value: v, label: t(v) }))} />
      {tab === 'overview' && <Overview />}
      {tab === 'matches' && <Matches />}
      {tab === 'risk' && <Risk />}
      {tab === 'payments' && <Payments />}
      {tab === 'users' && <Users />}
      {tab === 'audit' && <Audit />}
      {tab === 'settings' && <Settings />}
      {tab === 'integrations' && <Integrations />}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'emerald' | 'danger' | 'brand' }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={cn('mt-1 text-xl font-extrabold tabular-nums', tone === 'emerald' && 'text-emerald', tone === 'danger' && 'text-danger', tone === 'brand' && 'text-brand')}>{value}</p>
    </Card>
  );
}

function Overview() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const d = useQuery<any>({ queryKey: ['admin', 'dashboard'], queryFn: () => api('/admin/dashboard'), refetchInterval: 30_000 });
  const rec = useQuery<any>({ queryKey: ['admin', 'reconcile'], queryFn: () => api('/admin/ledger/reconcile'), refetchInterval: 60_000 });
  if (!d.data) return <div className="h-40 animate-pulse rounded-2xl bg-surface" />;
  const k = d.data.kpis;
  const m = (v: string) => formatMoney(v, locale);
  const max = Math.max(1, ...d.data.series.map((s: any) => Number(s.volume)));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label={t('volume')} value={m(k.money.volume)} />
        <Kpi label={t('ggr')} value={m(k.money.ggr)} tone={BigInt(k.money.ggr) >= 0n ? 'emerald' : 'danger'} />
        <Kpi label={t('payouts')} value={m(k.money.payouts)} />
        <Kpi label={t('hold')} value={k.money.holdPercent === null ? '—' : `${k.money.holdPercent}%`} />
        <Kpi label={t('openBets')} value={`${k.bets.open} · ${m(k.bets.open_stake)}`} tone="brand" />
        <Kpi label={t('settledBets')} value={k.bets.settled} />
        <Kpi label={t('liability')} value={m(k.bets.open_liability)} tone="danger" />
        <Kpi label={t('users')} value={`${k.users.total} (+${k.users.new24h})`} />
        <Kpi label={t('deposits')} value={m(k.payments.deposits)} />
        <Kpi label={t('withdrawals')} value={m(k.payments.withdrawals)} />
        <Kpi label={t('marketsOpen')} value={`${k.markets.open} / ${t('marketsSuspended')}: ${k.markets.suspended}`} />
        <Kpi label={t('apiErrors')} value={k.sync.errors24h} tone={k.sync.errors24h ? 'danger' : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t('volume')} · 14d</CardTitle></CardHeader>
          <CardContent>
            <div className="flex h-32 items-end gap-1" role="img" aria-label="volume per day">
              {d.data.series.map((s: any) => (
                <div key={s.day} className="group relative flex-1" title={`${s.day}: ${m(s.volume)} · GGR ${m(s.ggr)}`}>
                  <div className="rounded-t bg-brand/80" style={{ height: `${(Number(s.volume) / max) * 120}px` }} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('reconcile')}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {rec.data && (rec.data.ok ? <p className="flex items-center gap-2 text-emerald"><CheckCircle2 className="h-4 w-4" />{t('reconcileOk')}</p> : <p className="flex items-center gap-2 text-danger"><XCircle className="h-4 w-4" />{t('reconcileFail')}</p>)}
            <p className="text-xs text-muted">{t('prices')}: {k.markets.current_prices} · {k.matches.upcoming7d} upcoming · {k.matches.disrupted} disrupted</p>
            <p className="text-xs text-muted">House P&L: {m(k.ledger.house_pnl)} · Player balances: {m(k.ledger.player_balances)}</p>
          </CardContent>
        </Card>
      </div>
      <ExposureTable rows={d.data.exposure} />
    </div>
  );
}

function ExposureTable({ rows }: { rows: any[] }) {
  const t = useTranslations('admin');
  const locale = useLocale();
  return (
    <Card className="overflow-x-auto">
      <CardHeader><CardTitle>{t('risk')}</CardTitle></CardHeader>
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-left text-[11px] uppercase text-muted"><tr><th className="px-4 py-2">Match</th><th>Market</th><th>Sel.</th><th>Bets</th><th className="text-end pe-4">{t('liability')}</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={`${r.market_id}-${r.selection}`} className="border-t border-line/60"><td className="px-4 py-2">{r.home} – {r.away}</td><td>{r.market_key}</td><td>{r.selection}</td><td>{r.open_bets}</td><td className="pe-4 text-end font-bold tabular-nums text-danger">{formatMoney(r.liability, locale)}</td></tr>
        ))}</tbody>
      </table>
    </Card>
  );
}

function Risk() {
  const q = useQuery<any[]>({ queryKey: ['admin', 'exposure'], queryFn: () => api('/admin/exposure'), refetchInterval: 30_000 });
  const flags = useQuery<any[]>({ queryKey: ['admin', 'suspicious'], queryFn: () => api('/admin/suspicious') });
  const t = useTranslations('admin');
  const locale = useLocale();
  return (
    <div className="space-y-4">
      <ExposureTable rows={q.data ?? []} />
      <Card className="overflow-x-auto">
        <CardHeader><CardTitle>{t('flags')}</CardTitle></CardHeader>
        <table className="w-full min-w-[640px] text-sm"><tbody>{flags.data?.map((f) => (
          <tr key={f.id} className="border-t border-line/60"><td className="px-4 py-2">{formatDateTime(f.createdAt, locale)}</td><td><Badge variant={f.severity === 'HIGH' ? 'danger' : 'warn'}>{f.severity}</Badge></td><td className="font-semibold">{f.kind}</td><td className="font-mono text-xs text-muted">{JSON.stringify(f.details)}</td>
            <td className="pe-4">{f.status === 'OPEN' && <Button size="sm" variant="outline" onClick={async () => { await api(`/admin/suspicious/${f.id}`, { method: 'PATCH', json: { status: 'REVIEWED' } }); flags.refetch(); }}>OK</Button>}</td></tr>
        ))}</tbody></table>
      </Card>
    </div>
  );
}

function Matches() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const qc = useQueryClient();
  const q = useQuery<any[]>({ queryKey: ['admin', 'matches'], queryFn: () => api('/admin/matches') });
  const [editing, setEditing] = useState<string | null>(null);
  const [score, setScore] = useState({ h: '1', a: '0' });
  const [err, setErr] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (p: { path: string; json: unknown }) => api(p.path, { method: 'POST', json: p.json }),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['admin'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.code : 'ERROR'),
  });
  return (
    <Card className="overflow-x-auto">
      {err && <p className="m-3 rounded bg-danger/10 p-2 text-xs text-danger">{err}</p>}
      <table className="w-full min-w-[860px] text-sm">
        <thead className="text-left text-[11px] uppercase text-muted"><tr><th className="px-4 py-2">Kick-off</th><th>Match</th><th>Status</th><th>Markets</th><th>Bets</th><th>Result</th><th /></tr></thead>
        <tbody>{q.data?.map((m) => (
          <tr key={m.id} className="border-t border-line/60 align-middle">
            <td className="px-4 py-2 text-xs text-muted">{formatDateTime(m.kickoff_at, locale)}<br />{m.competition}</td>
            <td className="font-medium">{m.home} – {m.away}</td>
            <td><Badge>{m.status}</Badge></td>
            <td className="text-xs">{m.open_markets} / <span className="text-warn">{m.suspended_markets}</span></td>
            <td>{m.bets}</td>
            <td className="text-xs">{m.home_goals !== null ? `${m.home_goals}-${m.away_goals} (v${m.result_version}${m.result_source ? ` · ${m.result_source}` : ''})` : '—'}</td>
            <td className="space-x-1 whitespace-nowrap pe-4 text-end">
              <Button size="sm" variant="outline" onClick={() => act.mutate({ path: `/admin/matches/${m.id}/suspend`, json: { suspended: m.open_markets > 0 } })}>{m.open_markets > 0 ? t('suspend') : t('resume')}</Button>
              {editing === m.id ? (
                <span className="inline-flex items-center gap-1">
                  <Input className="h-8 w-12" value={score.h} onChange={(e) => setScore({ ...score, h: e.target.value })} />
                  <Input className="h-8 w-12" value={score.a} onChange={(e) => setScore({ ...score, a: e.target.value })} />
                  <Button size="sm" variant="emerald" onClick={() => { act.mutate({ path: `/admin/sandbox/matches/${m.id}/result`, json: { status: 'FINISHED', homeGoals: Number(score.h), awayGoals: Number(score.a) } }); setEditing(null); }}>OK</Button>
                  <Button size="sm" variant="danger" onClick={() => { act.mutate({ path: `/admin/sandbox/matches/${m.id}/result`, json: { status: 'CANCELLED' } }); setEditing(null); }}>CANC</Button>
                </span>
              ) : <Button size="sm" variant="ghost" onClick={() => setEditing(m.id)}>{t('setResult')}</Button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </Card>
  );
}

function Payments() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const q = useQuery<any[]>({ queryKey: ['admin', 'payments'], queryFn: () => api('/admin/payments') });
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm"><tbody>{q.data?.map((p) => (
        <tr key={p.id} className="border-t border-line/60"><td className="px-4 py-2 text-xs text-muted">{formatDateTime(p.createdAt, locale)}</td><td>{p.direction}</td><td>{p.method}</td><td><Badge variant={p.status === 'COMPLETED' ? 'emerald' : p.status === 'REQUIRES_REVIEW' ? 'warn' : 'default'}>{p.status}</Badge></td><td className="font-bold tabular-nums">{formatMoney(p.amount, locale)}</td>
          <td className="space-x-1 pe-4 text-end">{p.status === 'REQUIRES_REVIEW' && (<>
            <Button size="sm" variant="emerald" onClick={async () => { await api(`/admin/payments/${p.id}/approve`, { method: 'POST' }); q.refetch(); }}>{t('approve')}</Button>
            <Button size="sm" variant="danger" onClick={async () => { await api(`/admin/payments/${p.id}/reject`, { method: 'POST', json: { reason: 'Rejected by operator' } }); q.refetch(); }}>{t('reject')}</Button>
          </>)}</td></tr>
      ))}</tbody></table>
    </Card>
  );
}

function Users() {
  const locale = useLocale();
  const [s, setS] = useState('');
  const q = useQuery<any[]>({ queryKey: ['admin', 'users', s], queryFn: () => api(`/admin/users${s ? `?q=${encodeURIComponent(s)}` : ''}`) });
  return (
    <Card className="overflow-x-auto">
      <div className="p-3"><Input placeholder="e-mail…" value={s} onChange={(e) => setS(e.target.value)} /></div>
      <table className="w-full min-w-[760px] text-sm"><tbody>{q.data?.map((u) => (
        <tr key={u.id} className="border-t border-line/60"><td className="px-4 py-2">{u.email}</td><td><Badge variant={u.role === 'USER' ? 'default' : 'brand'}>{u.role}</Badge></td><td>{u.country}</td><td>{u.kycStatus}</td><td><Badge variant={u.status === 'ACTIVE' ? 'emerald' : 'danger'}>{u.status}</Badge></td><td className="text-xs text-muted">{formatDateTime(u.createdAt, locale)}</td>
          <td className="pe-4 text-end">{u.role === 'USER' && <Button size="sm" variant="outline" onClick={async () => { await api(`/admin/users/${u.id}`, { method: 'PATCH', json: { status: u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' } }); q.refetch(); }}>{u.status === 'ACTIVE' ? 'Suspend' : 'Activate'}</Button>}</td></tr>
      ))}</tbody></table>
    </Card>
  );
}

function Audit() {
  const locale = useLocale();
  const q = useQuery<any[]>({ queryKey: ['admin', 'audit'], queryFn: () => api('/admin/audit') });
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-xs"><tbody>{q.data?.map((a) => (
        <tr key={a.id} className="border-t border-line/60 align-top"><td className="whitespace-nowrap px-4 py-2 text-muted">{formatDateTime(a.createdAt, locale)}</td><td className="font-semibold">{a.action}</td><td>{a.actorRole ?? '—'}</td><td className="text-muted">{a.entityType}:{a.entityId?.slice(0, 8)}</td><td className="max-w-md truncate pe-4 font-mono text-muted">{a.after ? JSON.stringify(a.after) : ''}</td></tr>
      ))}</tbody></table>
    </Card>
  );
}

function Settings() {
  const t = useTranslations('admin');
  const q = useQuery<any>({ queryKey: ['admin', 'settings'], queryFn: () => api('/admin/settings') });
  const comps = useQuery<any[]>({ queryKey: ['admin', 'competitions'], queryFn: () => api('/admin/competitions') });
  const jur = useQuery<any[]>({ queryKey: ['admin', 'jurisdictions'], queryFn: () => api('/admin/jurisdictions') });
  const [margins, setMargins] = useState<Record<string, string>>({});
  const [risk, setRisk] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  if (!q.data) return null;
  const save = async (path: string, json: unknown) => {
    try { await api(path, { method: 'PATCH', json }); setMsg('✓'); q.refetch(); } catch (e) { setMsg(e instanceof ApiError ? `${e.code} ${JSON.stringify(e.details ?? '')}` : 'ERROR'); }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t('margins')}</CardTitle><Badge>{q.data.pricing.marginMethod}</Badge></CardHeader>
        <CardContent className="space-y-2">
          {Object.entries(q.data.pricing.margins).map(([k, v]) => (
            <label key={k} className="flex items-center justify-between gap-2 text-sm"><span className="text-muted">{k}</span>
              <Input className="h-9 w-24" value={margins[k] ?? String(v)} onChange={(e) => setMargins({ ...margins, [k]: e.target.value })} /></label>
          ))}
          <Button size="sm" onClick={() => save('/admin/settings/pricing', { margins: Object.fromEntries(Object.entries(margins).map(([k, v]) => [k, Number(v)])) })}>{t('settings')}</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('limits')}</CardTitle><Badge variant={q.data.realMoneyEnabled ? 'danger' : 'emerald'}>{q.data.realMoneyEnabled ? 'REAL MONEY' : 'SANDBOX'}</Badge></CardHeader>
        <CardContent className="space-y-2">
          {Object.entries(q.data.risk).map(([k, v]) => (
            <label key={k} className="flex items-center justify-between gap-2 text-sm"><span className="text-muted">{k}</span>
              <Input className="h-9 w-32" value={risk[k] ?? String(v)} onChange={(e) => setRisk({ ...risk, [k]: e.target.value })} /></label>
          ))}
          <Button size="sm" onClick={() => save('/admin/settings/risk', Object.fromEntries(Object.entries(risk).map(([k, v]) => [k, Number(v)])))}>{t('settings')}</Button>
          {msg && <p className="text-xs text-muted">{msg}</p>}
        </CardContent>
      </Card>
      <Card className="overflow-x-auto lg:col-span-2">
        <CardHeader><CardTitle>{t('competitions')}</CardTitle></CardHeader>
        <table className="w-full min-w-[720px] text-sm"><tbody>{comps.data?.map((c) => (
          <tr key={c.id} className="border-t border-line/60"><td className="px-4 py-2 font-medium">{c.name}</td><td className="text-xs text-muted">{c.country} · API-Football #{c.providerId}</td><td><Badge variant={c.coverageStatus === 'VERIFIED' ? 'emerald' : 'warn'}>{c.coverageStatus}</Badge></td>
            <td><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={c.enabled} onChange={async (e) => { await api(`/admin/competitions/${c.id}`, { method: 'PATCH', json: { enabled: e.target.checked } }); comps.refetch(); }} />enabled</label></td>
            <td className="pe-4"><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={c.bettingEnabled} onChange={async (e) => { await api(`/admin/competitions/${c.id}`, { method: 'PATCH', json: { bettingEnabled: e.target.checked } }); comps.refetch(); }} />betting</label></td></tr>
        ))}</tbody></table>
      </Card>
      <Card className="overflow-x-auto lg:col-span-2">
        <CardHeader><CardTitle>Jurisdictions</CardTitle></CardHeader>
        <table className="w-full text-sm"><tbody>{jur.data?.map((j) => (
          <tr key={j.country} className="border-t border-line/60"><td className="px-4 py-2 font-mono">{j.country}</td><td><Badge variant={j.status === 'BLOCKED' ? 'danger' : j.status === 'LICENSED' ? 'emerald' : 'warn'}>{j.status}</Badge></td><td className="pe-4 text-xs text-muted">{j.note}</td></tr>
        ))}</tbody></table>
      </Card>
    </div>
  );
}

function Integrations() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const runs = useQuery<any[]>({ queryKey: ['admin', 'runs'], queryFn: () => api('/admin/sync-runs'), refetchInterval: 15_000 });
  const models = useQuery<any[]>({ queryKey: ['admin', 'models'], queryFn: () => api('/admin/models') });
  const [out, setOut] = useState<string>('');
  const run = async (path: string) => {
    setOut('…');
    try { setOut(JSON.stringify(await api(path, { method: 'POST' }), null, 2).slice(0, 4000)); } catch (e) { setOut(e instanceof ApiError ? e.code : 'ERROR'); }
    runs.refetch(); models.refetch();
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t('runJob')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {['sync', 'history', 'coverage', 'price', 'external-odds', 'close', 'settle'].map((j) => <Button key={j} size="sm" variant="outline" onClick={() => run(`/admin/jobs/${j}`)}>{j}</Button>)}
            <Button size="sm" onClick={() => run('/admin/models/backtest')}>{t('backtest')}</Button>
          </div>
          {out && <pre className="max-h-72 overflow-auto rounded-xl bg-bg p-3 text-[11px] text-muted">{out}</pre>}
        </CardContent>
      </Card>
      <Card className="overflow-x-auto">
        <CardHeader><CardTitle>{t('integrations')}</CardTitle></CardHeader>
        <table className="w-full text-xs"><tbody>{runs.data?.map((r) => (
          <tr key={r.id} className="border-t border-line/60"><td className="px-4 py-1.5 text-muted">{formatDateTime(r.startedAt, locale)}</td><td>{r.provider}</td><td>{r.job}</td><td><Badge variant={r.status === 'SUCCESS' ? 'emerald' : r.status === 'RUNNING' ? 'brand' : 'danger'}>{r.status}</Badge></td><td>{r.items}</td><td className="max-w-[200px] truncate pe-4 text-danger">{r.error}</td></tr>
        ))}</tbody></table>
      </Card>
      <Card className="overflow-x-auto lg:col-span-2">
        <CardHeader><CardTitle>Model runs</CardTitle></CardHeader>
        <table className="w-full text-xs"><tbody>{models.data?.map((m) => (
          <tr key={m.id} className="border-t border-line/60"><td className="px-4 py-1.5 text-muted">{formatDateTime(m.fittedAt, locale)}</td><td>{m.modelVersion}</td><td>n={m.nMatches}</td><td>home={Number(m.homeAdvantage).toFixed(3)}</td><td>ρ={Number(m.rho).toFixed(3)}</td>
            <td className="pe-4">{m.metrics ? `Brier ${m.metrics.model.brier.toFixed(4)} (base ${m.metrics.baseline.brier.toFixed(4)}) · LogLoss ${m.metrics.model.logLoss.toFixed(4)} · ECE ${m.metrics.model.ece.toFixed(4)}` : ''}</td></tr>
        ))}</tbody></table>
      </Card>
    </div>
  );
}
