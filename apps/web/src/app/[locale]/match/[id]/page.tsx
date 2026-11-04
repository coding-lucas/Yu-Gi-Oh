'use client';
import { use } from 'react';
import { MatchView } from '@/components/match-view';

export default function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <MatchView id={decodeURIComponent(id)} />;
}
