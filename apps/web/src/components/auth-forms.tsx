'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useErrorMessage } from '@/lib/labels';
import { userTz } from '@/lib/utils';
import { Link, useRouter } from '@/i18n/navigation';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Field, Input, Select } from './ui/input';
import { LogoMark } from './logo';

const COUNTRIES = ['BR', 'PT', 'AR', 'CL', 'UY', 'CO', 'MX', 'GB', 'ES', 'IT', 'DE', 'FR', 'NL', 'US', 'CA', 'JP', 'KR', 'CN', 'IN', 'AE', 'SA', 'EG', 'MA', 'NG', 'ZA', 'AU'];

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="mx-auto mt-6 max-w-md">
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-col items-center gap-2"><LogoMark className="h-12 w-12" /><h1 className="text-xl font-extrabold">{title}</h1></div>
        {children}
      </CardContent>
    </Card>
  );
}

export function LoginForm() {
  const t = useTranslations();
  const err = useErrorMessage();
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Shell title={t('auth.loginTitle')}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const s = await api('/auth/login', { method: 'POST', json: { email, password, ...(totp ? { totp } : {}) } });
          await qc.invalidateQueries();
          router.push(s.user.role !== 'USER' ? '/admin' : '/');
        } catch (x) {
          const code = x instanceof ApiError ? x.code : undefined;
          if (code === 'MFA_CODE_REQUIRED') setNeedTotp(true);
          setError(err(code));
        } finally {
          setBusy(false);
        }
      }}>
        <Field label={t('auth.email')}><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('auth.password')}><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {needTotp && <Field label={t('auth.totp')}><Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} /></Field>}
        {error && <p className="rounded-lg bg-danger/10 p-2 text-xs text-danger">{error}</p>}
        <Button className="w-full" size="lg" disabled={busy}>{t('nav.login')}</Button>
      </form>
      <div className="flex justify-between text-xs text-muted">
        <Link href="/forgot" className="hover:text-fg">{t('auth.forgot')}</Link>
        <span>{t('auth.noAccount')} <Link href="/register" className="font-semibold text-emerald">{t('nav.register')}</Link></span>
      </div>
    </Shell>
  );
}

export function RegisterForm() {
  const t = useTranslations();
  const err = useErrorMessage();
  const locale = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const [f, setF] = useState({ email: '', password: '', displayName: '', dateOfBirth: '', country: locale === 'pt' ? 'BR' : 'GB', acceptTerms: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });
  const region = (c: string) => { try { return new Intl.DisplayNames([locale], { type: 'region' }).of(c) ?? c; } catch { return c; } };
  return (
    <Shell title={t('auth.registerTitle')}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api('/auth/register', { method: 'POST', json: { ...f, locale, timezone: userTz() } });
          await qc.invalidateQueries();
          router.push('/');
        } catch (x) {
          setError(err(x instanceof ApiError ? x.code : undefined));
        } finally {
          setBusy(false);
        }
      }}>
        <Field label={t('auth.displayName')}><Input required minLength={2} maxLength={40} value={f.displayName} onChange={set('displayName')} /></Field>
        <Field label={t('auth.email')}><Input type="email" required value={f.email} onChange={set('email')} /></Field>
        <Field label={t('auth.password')} hint={t('auth.passwordHint')}><Input type="password" autoComplete="new-password" required minLength={10} value={f.password} onChange={set('password')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('auth.dob')}><Input type="date" required value={f.dateOfBirth} onChange={set('dateOfBirth')} /></Field>
          <Field label={t('auth.country')}><Select value={f.country} onChange={set('country')}>{COUNTRIES.map((c) => <option key={c} value={c}>{region(c)}</option>)}</Select></Field>
        </div>
        <label className="flex items-start gap-2 text-xs text-muted"><input type="checkbox" required checked={f.acceptTerms} onChange={set('acceptTerms')} className="mt-0.5" />{t('auth.terms')}</label>
        {error && <p className="rounded-lg bg-danger/10 p-2 text-xs text-danger">{error}</p>}
        <Button className="w-full" variant="emerald" size="lg" disabled={busy}>{t('nav.register')}</Button>
      </form>
      <p className="text-center text-xs text-muted">{t('auth.hasAccount')} <Link href="/login" className="font-semibold text-brand">{t('nav.login')}</Link></p>
    </Shell>
  );
}

export function ForgotForm() {
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const err = useErrorMessage();
  const [error, setError] = useState<string | null>(null);
  return (
    <Shell title={t('reset')}>
      {!sent ? (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const r = await api('/auth/password/forgot', { method: 'POST', json: { email } }); if (r.devToken) setToken(r.devToken); setSent(true); }}>
          <Field label={t('email')}><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button className="w-full">{t('reset')}</Button>
        </form>
      ) : done ? (
        <p className="text-center text-sm text-emerald">✓</p>
      ) : (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); try { await api('/auth/password/reset', { method: 'POST', json: { token, password } }); setDone(true); } catch (x) { setError(err(x instanceof ApiError ? x.code : undefined)); } }}>
          <p className="text-xs text-muted">{t('resetSent')}</p>
          <Field label="Token"><Input value={token} onChange={(e) => setToken(e.target.value)} /></Field>
          <Field label={t('newPassword')} hint={t('passwordHint')}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {error && <p className="text-xs text-danger">{error}</p>}
          <Button className="w-full">{t('reset')}</Button>
        </form>
      )}
    </Shell>
  );
}
