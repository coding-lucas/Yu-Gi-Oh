import { cn } from '@/lib/utils';

/** AthosBet mark: an "A" peak whose crossbar is a rising trend line ending in a ball. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={cn('h-8 w-8', className)} aria-hidden="true">
      <defs>
        <linearGradient id="ab-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2F7BFF" />
          <stop offset="1" stopColor="#12C48B" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#ab-g)" />
      <path d="M13 36 L24 11 L35 36" fill="none" stroke="#fff" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 29 L22 25.5 L26 27.5 L31.5 21.5" fill="none" stroke="#0B1016" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="33.5" cy="19.5" r="3.2" fill="#fff" stroke="#0B1016" strokeWidth="1.6" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark />
      <span className="text-lg font-extrabold tracking-tight" dir="ltr">
        <span className="text-fg">Athos</span>
        <span className="text-emerald">Bet</span>
      </span>
    </span>
  );
}
