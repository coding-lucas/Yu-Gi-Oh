'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { MatchView } from '@/components/match-view';

function ByQuery() {
  const id = useSearchParams().get('id');
  return id ? <MatchView id={id} /> : null;
}

/** /match?id=… — used by the static demo build (no dynamic routes in a static export). */
export default function MatchByQuery() {
  return <Suspense><ByQuery /></Suspense>;
}
