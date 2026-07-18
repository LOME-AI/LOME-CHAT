import * as React from 'react';
import { OTHERS_COLOR, formatDelta, formatShare, type RankedModel } from './compute-stats';

interface RankedListProps {
  readonly models: readonly RankedModel[];
  readonly others: { readonly sharePercent: number; readonly deltaPoints: number | null };
  readonly showDelta: boolean;
}

/**
 * Ranked model-share list; doubles as the text alternative for the trend
 * chart. Others always closes the list. Delta badges appear only when the
 * window has a prior comparison window and the row carries a delta.
 */
export function RankedList({ models, others, showDelta }: RankedListProps): React.JSX.Element {
  return (
    <ol aria-label="Model share ranking" className="flex flex-col">
      {models.map((model) => (
        <Row
          key={model.modelId}
          rank={String(model.rank)}
          color={model.color}
          label={model.displayName}
          share={model.sharePercent}
          delta={showDelta ? model.deltaPoints : null}
        />
      ))}
      {others.sharePercent !== 0 && (
        <Row
          rank=""
          color={OTHERS_COLOR}
          label="Others"
          share={others.sharePercent}
          delta={showDelta ? others.deltaPoints : null}
        />
      )}
    </ol>
  );
}

interface RowProps {
  readonly rank: string;
  readonly color: string;
  readonly label: string;
  readonly share: number;
  readonly delta: number | null;
}

function Row({ rank, color, label, share, delta }: RowProps): React.JSX.Element {
  return (
    <li className="border-border flex items-center gap-3 border-b py-2.5 text-sm last:border-b-0">
      <span className="text-muted-foreground w-5 shrink-0 text-right font-mono text-xs tabular-nums">
        {rank}
      </span>
      <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0 rounded-xs" aria-hidden="true">
        <rect width="10" height="10" fill={color} />
      </svg>
      <span className="text-foreground min-w-0 flex-1 truncate">{label}</span>
      {delta !== null && (
        // Positive deltas use default ink in light mode: light --success on the
        // warm paper background measures ~3.13:1 at this size, under the 4.5:1
        // AA floor, and no committed token offers a stronger success shade. The
        // sign already carries the meaning. Dark --success measures ~7.7:1, so
        // dark mode keeps the green.
        <span
          className={`font-mono text-xs tabular-nums ${delta < 0 ? 'text-muted-foreground' : 'text-foreground dark:text-success'}`}
        >
          {formatDelta(delta)}
        </span>
      )}
      <span className="text-foreground w-16 shrink-0 text-right font-mono tabular-nums">
        {formatShare(share)}
      </span>
    </li>
  );
}
