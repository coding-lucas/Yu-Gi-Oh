'use client';
import { useId, useState } from 'react';

export interface CrestTeam {
  name: string;
  shortName?: string | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  crestPattern?: 'solid' | 'stripes' | 'hoops' | 'sash' | 'halves' | string | null;
}

const FALLBACK = ['#2F7BFF', '#12C48B', '#F5B83D', '#E5484D', '#8E6CFF', '#00B8D9', '#FF7A45', '#7BD389'];
const SHIELD = 'M24 2.5 L44 8.5 V26 C44 40 34.5 49.5 24 54.5 C13.5 49.5 4 40 4 26 V8.5 Z';

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function initials(t: CrestTeam) {
  if (t.shortName) return t.shortName.slice(0, 3).toUpperCase();
  const w = t.name.split(' ').filter(Boolean);
  return (w.length > 1 ? w.map((x) => x[0]).join('') : t.name.slice(0, 3)).slice(0, 3).toUpperCase();
}

/**
 * Team crest. Shows the official crest only when it comes from a licensed source (data-feed logo or
 * an operator-uploaded asset); otherwise renders AthosBet's own heraldic shield in the club's colours
 * with its monogram — never an imitation of a registered crest.
 */
export function TeamCrest({ team, size = 24, className }: { team: CrestTeam; size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  const [broken, setBroken] = useState(false);
  if (team.logoUrl && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={team.logoUrl} alt="" width={size} height={size} onError={() => setBroken(true)} className={`shrink-0 object-contain drop-shadow ${className ?? ''}`} style={{ width: size, height: size }} loading="lazy" decoding="async" />;
  }
  const h = hash(team.name);
  const p = team.primaryColor ?? FALLBACK[h % FALLBACK.length];
  const s = team.secondaryColor ?? (luminance(p) > 0.5 ? '#111827' : '#FFFFFF');
  const pattern = team.crestPattern ?? 'solid';
  const label = initials(team);
  const dark = luminance(p) < 0.35 && luminance(s) < 0.35;
  const rim = dark ? '#5B6575' : '#0B1016';
  return (
    <svg viewBox="0 0 48 57" width={size} height={(size * 57) / 48} className={`shrink-0 ${className ?? ''}`} role="img" aria-label={team.name}>
      <defs>
        <clipPath id={`c${id}`}><path d={SHIELD} /></clipPath>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#c${id})`}>
        <rect width="48" height="57" fill={p} />
        {pattern === 'stripes' && [8, 24, 40].map((x) => <rect key={x} x={x - 4} y="0" width="8" height="57" fill={s} />)}
        {pattern === 'hoops' && [12, 28, 44].map((y) => <rect key={y} x="0" y={y - 4} width="48" height="8" fill={s} />)}
        {pattern === 'sash' && <path d="M-2 12 L10 0 L50 44 L38 57 Z" fill={s} />}
        {pattern === 'halves' && <rect x="24" y="0" width="24" height="57" fill={s} />}
        <rect width="48" height="57" fill={`url(#g${id})`} />
      </g>
      <path d={SHIELD} fill="none" stroke={rim} strokeWidth="2.2" />
      <path d={SHIELD} fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="0.9" transform="translate(24 28.5) scale(0.88) translate(-24 -28.5)" />
      <circle cx="24" cy="28" r="12.5" fill="#0B1016" fillOpacity="0.82" stroke="#fff" strokeOpacity="0.7" strokeWidth="0.8" />
      <text x="24" y="28" textAnchor="middle" dominantBaseline="central" fontFamily="Inter, system-ui, sans-serif" fontWeight="800" fontSize={label.length > 2 ? 9 : 11} fill="#fff" letterSpacing="0.3">{label}</text>
    </svg>
  );
}

/** @deprecated use TeamCrest */
export const TeamBadge = TeamCrest;
