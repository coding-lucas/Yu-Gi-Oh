import { cn } from '@/lib/utils';

const PALETTE = ['#2F7BFF', '#12C48B', '#F5B83D', '#E5484D', '#8E6CFF', '#00B8D9', '#FF7A45', '#7BD389'];

/** Team crest from the provider when available, otherwise a deterministic monogram (no third-party marks). */
export function TeamBadge({ name, logo, size = 20 }: { name: string; logo?: string | null; size?: number }) {
  if (logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo} alt="" width={size} height={size} className="shrink-0 rounded-full object-contain" loading="lazy" />;
  }
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const initials = name.replace(/[^\p{L}\p{N} ]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white')} style={{ width: size, height: size, fontSize: size * 0.42, background: PALETTE[h % PALETTE.length] }} aria-hidden>
      {initials}
    </span>
  );
}
