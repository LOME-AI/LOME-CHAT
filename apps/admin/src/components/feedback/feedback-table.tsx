import * as React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge, IconButton, cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { CopyableId } from '@/components/util/copyable-id';
import { formatTime } from '@/lib/format-time';
import { FeedbackDetailRow } from './feedback-detail-row.js';
import type { FeedbackInboxRowWire } from '@hushbox/shared';

const COLUMN_COUNT = 6;

function FeedbackRow({
  row,
  expanded,
  onToggle,
}: Readonly<{
  row: FeedbackInboxRowWire;
  expanded: boolean;
  onToggle: () => void;
}>): React.JSX.Element {
  return (
    <>
      <tr className={cn('border-border border-b', expanded && 'bg-accent')}>
        <td className="py-1 pr-1">
          <IconButton
            data-testid={TEST_IDS.adminFeedbackExpand}
            aria-label={expanded ? 'Collapse feedback details' : 'Expand feedback details'}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </IconButton>
        </td>
        <td className="py-1 pr-2">
          <CopyableId value={row.id} label="feedback id" />
        </td>
        <td className="py-1 pr-2">
          <Badge variant="outline" className="font-mono text-xs">
            {row.kind}
          </Badge>
        </td>
        <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{row.status}</td>
        <td className="text-muted-foreground max-w-80 truncate py-1 pr-2 text-xs">
          {row.bodyPreview}
        </td>
        <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">
          {formatTime(row.createdAt)}
        </td>
      </tr>
      {expanded ? <FeedbackDetailRow row={row} columnCount={COLUMN_COUNT} /> : null}
    </>
  );
}

/**
 * The feedback inbox table: a dense preview row per submission, each with a
 * leading chevron that drops an inline detail row beneath it (single-open, owned
 * by the caller). The full body is never here — it rides the audited detail read
 * behind the expanded row.
 */
export function FeedbackTable({
  rows,
  expandedId,
  onToggle,
}: Readonly<{
  rows: readonly FeedbackInboxRowWire[];
  expandedId?: string | undefined;
  onToggle: (id: string) => void;
}>): React.JSX.Element {
  return (
    // Wide-table rule: the table scrolls in its own container so the page
    // never scrolls sideways.
    <div className="overflow-x-auto">
      <table data-testid={TEST_IDS.adminFeedbackTable} className="w-full text-left text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-xs uppercase">
            <th className="py-1 pr-1 font-medium">
              <span className="sr-only">Expand</span>
            </th>
            <th className="py-1 pr-2 font-medium">Id</th>
            <th className="py-1 pr-2 font-medium">Kind</th>
            <th className="py-1 pr-2 font-medium">Status</th>
            <th className="py-1 pr-2 font-medium">Preview</th>
            <th className="py-1 pr-2 font-medium">Received</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <FeedbackRow
              key={row.id}
              row={row}
              expanded={expandedId === row.id}
              onToggle={() => {
                onToggle(row.id);
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
