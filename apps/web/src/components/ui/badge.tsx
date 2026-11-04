import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const badge = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide', {
  variants: {
    variant: {
      default: 'bg-elevated text-muted',
      brand: 'bg-brand/15 text-brand',
      emerald: 'bg-emerald/15 text-emerald',
      danger: 'bg-danger/15 text-danger',
      warn: 'bg-warn/15 text-warn',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({ className, variant, ...p }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ variant }), className)} {...p} />;
}
