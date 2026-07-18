import * as React from 'react';
import { formatUsd, type DotPlotEntry } from './compute-stats';

interface CostDotPlotProps {
  readonly entries: readonly DotPlotEntry[];
}

/**
 * Per-model average-cost dot plot on a shared log-scale axis. Each row's
 * name + cost text is the accessible alternative; the track and dot are
 * decorative positioning. The dot's `left` offset is layout, not color, so
 * an inline style is fine under the accessibility conventions.
 */
export function CostDotPlot({ entries }: CostDotPlotProps): React.JSX.Element {
  return (
    <ul aria-label="Average cost per model, log scale" className="flex flex-col gap-2">
      {entries.map((entry) => (
        <li key={entry.modelId} className="flex items-center gap-3 text-sm">
          {/* Fixed (not content-sized) width keeps every row's track aligned;
              the md step lets desktop show full names while mobile keeps the
              narrow truncating column. The full name stays in the text node
              as the accessible alternative. */}
          <span className="text-foreground w-40 min-w-0 shrink-0 truncate md:w-64">
            {entry.displayName}
          </span>
          <span className="relative h-3 min-w-0 flex-1" aria-hidden="true">
            <span className="bg-border absolute top-1/2 right-0 left-0 h-px" />
            <span
              data-dot
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${String(entry.position)}%` }}
            >
              <svg viewBox="0 0 10 10" className="block h-2.5 w-2.5" aria-hidden="true">
                <circle cx="5" cy="5" r="5" fill={entry.color} />
              </svg>
            </span>
          </span>
          <span className="text-foreground w-20 shrink-0 text-right font-mono text-xs tabular-nums">
            {formatUsd(entry.avgCostUsd)}
          </span>
        </li>
      ))}
    </ul>
  );
}
