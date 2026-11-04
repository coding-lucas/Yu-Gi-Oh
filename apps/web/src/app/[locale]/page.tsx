import { setRequestLocale } from 'next-intl/server';
import { MatchBoard } from '@/components/match-board';

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <MatchBoard initialFilter="week" />;
}
