import { cn } from '@hushbox/ui/lib/utils';
import { VERDICT_META } from '../app/verdict-utilities';
import type { Verdict } from '../engine';
import type { JSX, ReactNode } from 'react';

interface VerdictPillProps {
  level: Verdict;
  /** Optional label to the right (e.g. an audience name). */
  children?: ReactNode;
  className?: string;
}

/**
 * The atomic PASS / WARN / FAIL indicator. Meaning is carried by the text label
 * and the symbol as well as color, so it survives desaturation.
 */
export function VerdictPill({
  level,
  children,
  className,
}: Readonly<VerdictPillProps>): JSX.Element {
  const meta = VERDICT_META[level];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold',
        meta.surface,
        meta.text,
        className
      )}
    >
      <span aria-hidden>{meta.symbol}</span>
      <span>{meta.label}</span>
      {children ? <span className="text-foreground font-medium">{children}</span> : null}
    </span>
  );
}
