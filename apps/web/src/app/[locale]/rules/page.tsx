'use client';
import { useLocale, useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { useMeta } from '@/components/providers';

export default function Rules() {
  const t = useTranslations();
  const locale = useLocale();
  const meta = useMeta();
  return (
    <Card className="mx-auto max-w-3xl">
      <CardContent className="space-y-4 p-6">
        <h1 className="text-xl font-extrabold">{t('common.rules')}</h1>
        {meta.data && Object.entries(meta.data.marketRules).map(([k, v]) => (
          <section key={k}>
            <h2 className="text-sm font-bold">{k === 'GENERAL' ? t('match.rulesTitle') : t(`markets.${k}` as any, { line: '' })}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">{locale === 'pt' ? v.pt : v.en}</p>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
