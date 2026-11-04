'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Globe, Home, LogOut, Radio, Shield, Ticket, User, Wallet } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { LOCALES, LOCALE_NAMES } from '@athosbet/shared';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { cn, formatMoney } from '@/lib/utils';
import { Logo } from './logo';
import { useMe, useMeta, useWallet } from './providers';
import { buttonVariants } from './ui/button';

export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('common');
  const qc = useQueryClient();
  return (
    <label className={cn('relative flex items-center gap-1 text-sm', className)}>
      <Globe className="h-4 w-4 text-muted" />
      <span className="sr-only">{t('language')}</span>
      <select
        value={locale}
        onChange={(e) => {
          const next = e.target.value;
          // persist preference for logged-in users (UI only — never affects jurisdiction)
          api('/account/profile', { method: 'PATCH', json: { locale: next } }).then(() => qc.invalidateQueries({ queryKey: ['me'] })).catch(() => undefined);
          router.replace(pathname, { locale: next as any });
        }}
        className="cursor-pointer appearance-none bg-transparent pe-1 text-sm font-medium focus:outline-none"
      >
        {LOCALES.map((l) => <option key={l} value={l} className="bg-surface">{LOCALE_NAMES[l]}</option>)}
      </select>
    </label>
  );
}

export function SandboxBanner() {
  const t = useTranslations('common');
  const meta = useMeta();
  return (
    <div className="bg-gradient-to-r from-brand/20 via-emerald/15 to-brand/20 px-4 py-1.5 text-center text-[11px] font-medium text-fg/90">
      {t('sandbox')}{meta.data?.synthetic ? ` · ${t('syntheticData')}` : ''}
    </div>
  );
}

export function Header() {
  const t = useTranslations('nav');
  const locale = useLocale();
  const { data: me } = useMe();
  const wallet = useWallet(!!me);
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const links = [
    { href: '/', label: t('home') },
    { href: '/live', label: t('live') },
    { href: '/bets', label: t('bets') },
    { href: '/wallet', label: t('wallet') },
  ];
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-3 sm:px-4">
        <Link href="/" aria-label="AthosBet"><Logo /></Link>
        <nav className="ms-4 hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={cn('rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:text-fg', pathname === l.href && 'bg-elevated text-fg')}>{l.label}</Link>
          ))}
          {me && me.role !== 'USER' && <Link href="/admin" className="rounded-lg px-3 py-1.5 text-sm font-medium text-brand hover:bg-elevated">{t('admin')}</Link>}
        </nav>
        <div className="ms-auto flex items-center gap-2">
          <LanguageSwitcher className="hidden sm:flex" />
          {me ? (
            <>
              <Link href="/wallet" className="rounded-xl border border-line bg-surface px-3 py-1.5 text-sm font-bold tabular-nums text-emerald">
                {wallet.data ? formatMoney(wallet.data.balance, locale, wallet.data.currency) : '…'}
              </Link>
              <Link href="/account" className="hidden rounded-xl p-2 hover:bg-elevated md:block" aria-label={t('account')}><User className="h-5 w-5" /></Link>
              <button
                className="hidden rounded-xl p-2 text-muted hover:bg-elevated hover:text-fg md:block"
                aria-label={t('logout')}
                onClick={async () => { await api('/auth/logout', { method: 'POST' }).catch(() => undefined); qc.clear(); router.push('/'); }}
              ><LogOut className="h-5 w-5" /></button>
            </>
          ) : (
            <>
              <Link href="/login" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{t('login')}</Link>
              <Link href="/register" className={buttonVariants({ variant: 'emerald', size: 'sm' })}>{t('register')}</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function BottomNav() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const { data: me } = useMe();
  const items = [
    { href: '/', icon: Home, label: t('home') },
    { href: '/live', icon: Radio, label: t('live') },
    { href: '/bets', icon: Ticket, label: t('bets') },
    { href: '/wallet', icon: Wallet, label: t('wallet') },
    me && me.role !== 'USER' ? { href: '/admin', icon: Shield, label: t('admin') } : { href: '/account', icon: User, label: t('account') },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden" aria-label="primary">
      <ul className="grid grid-cols-5">
        {items.map(({ href, icon: Icon, label }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link href={href} className={cn('flex h-16 flex-col items-center justify-center gap-1 text-[10px] font-medium', active ? 'text-emerald' : 'text-muted')}>
                <Icon className="h-5 w-5" />
                <span className="max-w-full truncate px-1">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function Footer() {
  const t = useTranslations('common');
  return (
    <footer className="mx-auto mt-10 max-w-7xl px-4 pb-28 pt-6 text-xs text-muted md:pb-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-6">
        <Logo className="scale-90" />
        <Link href="/rules" className="hover:text-fg">{t('rules')}</Link>
        <Link href="/responsible-gaming" className="hover:text-fg">{t('responsible')}</Link>
        <LanguageSwitcher className="sm:hidden" />
        <span className="ms-auto rounded-full border border-line px-2 py-0.5 font-bold">18+</span>
      </div>
      <p className="mt-3">{t('age')} © {new Date().getFullYear()} AthosBet · Athos Software.</p>
    </footer>
  );
}
