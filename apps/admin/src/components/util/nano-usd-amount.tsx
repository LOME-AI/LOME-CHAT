import * as React from 'react';
import { cn } from '@hushbox/ui';
import { formatNanoUsd } from '@/lib/nano-usd';

interface NanoUsdAmountProps {
  /** Signed NanoUSD wire string, preserved exactly in the title attribute. */
  readonly wire: string;
  readonly className?: string;
}

/** Dollar rendering of a NanoUSD wire string; negatives read as attention. */
export function NanoUsdAmount({ wire, className }: NanoUsdAmountProps): React.JSX.Element {
  const negative = wire.startsWith('-');
  return (
    <span
      title={`${wire} nano-USD`}
      className={cn('font-mono text-xs tabular-nums', negative && 'text-destructive', className)}
    >
      {formatNanoUsd(wire)}
    </span>
  );
}
