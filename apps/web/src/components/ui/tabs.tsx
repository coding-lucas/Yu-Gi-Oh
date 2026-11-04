'use client';
import { cn } from '@/lib/utils';

export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[]; className?: string }) {
  return (
    <div role="tablist" className={cn('flex gap-1 overflow-x-auto rounded-xl bg-surface p-1 no-scrollbar', className)}>
      {items.map((i) => (
        <button
          key={i.value}
          role="tab"
          aria-selected={value === i.value}
          onClick={() => onChange(i.value)}
          className={cn('shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors', value === i.value ? 'bg-brand text-white shadow' : 'text-muted hover:text-fg')}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}
