import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { isRtl } from '@athosbet/shared';
import { routing } from '@/i18n/routing';
import { Providers } from '@/components/providers';
import { BottomNav, Footer, Header, SandboxBanner } from '@/components/shell';
import { BetSlipSheet } from '@/components/bet-slip';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as any)) notFound();
  setRequestLocale(locale);
  const messages = await getMessages();
  return (
    <html lang={locale} dir={isRtl(locale) ? 'rtl' : 'ltr'} className="dark">
      <body className="min-h-screen font-sans antialiased">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <Providers>
            <SandboxBanner />
            <Header />
            <main className="mx-auto max-w-7xl px-3 pt-4 sm:px-4">{children}</main>
            <Footer />
            <BottomNav />
            <BetSlipSheet />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
