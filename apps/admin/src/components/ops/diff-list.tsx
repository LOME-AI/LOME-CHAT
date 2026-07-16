import * as React from 'react';
import { MoveRight } from 'lucide-react';
import { Badge } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import type { AdminOpEffect } from '@hushbox/shared';

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return 'none';
  }
  return JSON.stringify(value);
}

interface DiffListProps {
  readonly effects: readonly AdminOpEffect[];
}

/** The preview step's change list: one before-to-after row per effect. */
export function DiffList({ effects }: DiffListProps): React.JSX.Element {
  if (effects.length === 0) {
    return (
      <p data-testid={TEST_IDS.adminOpDiff} className="text-muted-foreground text-sm">
        No changes.
      </p>
    );
  }
  return (
    <ul data-testid={TEST_IDS.adminOpDiff} className="flex flex-col gap-1">
      {effects.map((effect, index) => {
        const isAddition = effect.before === undefined || effect.before === null;
        return (
          <li
            key={`${effect.label}-${String(index)}`}
            className="border-border bg-card flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
          >
            <span className="font-mono text-xs">{effect.label}</span>
            {isAddition ? (
              <>
                <Badge variant="secondary" className="text-success">
                  added
                </Badge>
                <span className="font-mono text-xs break-all">{formatValue(effect.after)}</span>
              </>
            ) : (
              <span className="text-muted-foreground flex flex-wrap items-center gap-1.5 font-mono text-xs">
                <span className="break-all line-through">{formatValue(effect.before)}</span>
                <MoveRight aria-hidden="true" className="h-3 w-3 shrink-0" />
                <span className="text-foreground break-all">{formatValue(effect.after)}</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
