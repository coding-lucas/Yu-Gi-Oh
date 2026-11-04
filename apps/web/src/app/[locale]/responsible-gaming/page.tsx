import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { buttonVariants } from '@/components/ui/button';

export default async function RG() {
  const t = await getTranslations();
  return (
    <Card className="mx-auto max-w-3xl">
      <CardContent className="space-y-4 p-6">
        <h1 className="text-xl font-extrabold">{t('rg.title')}</h1>
        <p className="text-sm leading-relaxed text-muted">{t('rg.body')}</p>
        <p className="text-sm font-semibold">{t('common.age')}</p>
        <Link href="/account" className={buttonVariants({ variant: 'outline' })}>{t('rg.tools')}</Link>
      </CardContent>
    </Card>
  );
}
