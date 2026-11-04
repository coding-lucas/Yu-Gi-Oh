'use client';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useMe } from './providers';
import { Card } from './ui/card';
import { buttonVariants } from './ui/button';

export function RequireAuth({ children, staff = false }: { children: React.ReactNode; staff?: boolean }) {
  const t = useTranslations();
  const { data: me, isLoading } = useMe();
  if (isLoading) return <div className="h-40 animate-pulse rounded-2xl bg-surface" />;
  if (!me || (staff && me.role === 'USER')) {
    return (
      <Card className="mx-auto max-w-md p-8 text-center">
        <p className="mb-4 text-sm text-muted">{t('errors.UNAUTHORIZED')}</p>
        <Link href="/login" className={buttonVariants()}>{t('nav.login')}</Link>
      </Card>
    );
  }
  return <>{children}</>;
}
