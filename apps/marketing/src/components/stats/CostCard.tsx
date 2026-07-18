import * as React from 'react';
import { formatUsd } from './compute-stats';
import type { UsageStatsWindowStats } from '@hushbox/shared';

interface CostCardProps {
  readonly cost: UsageStatsWindowStats['cost'];
}

export function CostCard({ cost }: CostCardProps): React.JSX.Element {
  return (
    <div className="border-border bg-background-subtle/40 flex flex-col gap-4 rounded-lg border p-6">
      <div className="flex flex-col gap-1">
        <span className="text-foreground font-mono text-4xl tabular-nums">
          {formatUsd(cost.avgUsd)}
        </span>
        <span className="text-muted-foreground text-sm">average cost per message</span>
      </div>
      <dl className="flex gap-8">
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
            median
          </dt>
          <dd className="text-foreground font-mono tabular-nums">{formatUsd(cost.medianUsd)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground font-mono text-xs tracking-widest uppercase">p90</dt>
          <dd className="text-foreground font-mono tabular-nums">{formatUsd(cost.p90Usd)}</dd>
        </div>
      </dl>
    </div>
  );
}
