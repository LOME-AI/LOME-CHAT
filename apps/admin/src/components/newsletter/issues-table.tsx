import * as React from 'react';
import { Button } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { CopyableId } from '@/components/util/copyable-id';
import { formatTime } from '@/lib/format-time';
import { DenseTable } from './dense-table.js';
import type { NewsletterIssueWire } from '@hushbox/shared';

const EM_DASH = '—';

function counts(row: NewsletterIssueWire): string {
  if (row.sentCount === null || row.recipientCount === null) {
    return EM_DASH;
  }
  return `${String(row.sentCount)} / ${String(row.recipientCount)}`;
}

function IssueRow({ row }: Readonly<{ row: NewsletterIssueWire }>): React.JSX.Element {
  const runOp = useRunOp();
  return (
    <tr className="border-border border-b">
      <td className="py-1 pr-2">
        <CopyableId value={row.id} label="issue id" />
      </td>
      <td className="max-w-80 truncate py-1 pr-2 text-xs">{row.subject}</td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{row.status}</td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{counts(row)}</td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">
        {row.failedCount === null ? EM_DASH : String(row.failedCount)}
      </td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">
        {formatTime(row.scheduledAt)}
      </td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">
        {row.sentAt === null ? EM_DASH : formatTime(row.sentAt)}
      </td>
      <td className="text-muted-foreground py-1 pr-2 font-mono text-xs whitespace-nowrap">
        {row.createdBy}
      </td>
      <td className="py-1">
        {row.status === 'scheduled' ? (
          <Button
            data-testid={TEST_IDS.adminNewsletterCancel}
            size="sm"
            variant="outline"
            onClick={() => {
              runOp({ opName: 'newsletter.cancel', initialValues: { issueId: row.id } });
            }}
          >
            Cancel
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

const HEADERS = [
  { label: 'Id' },
  { label: 'Subject' },
  { label: 'Status' },
  { label: 'Sent / Recipients' },
  { label: 'Failed' },
  { label: 'Scheduled' },
  { label: 'Sent at' },
  { label: 'By' },
  { label: 'Actions', srOnly: true },
] as const;

/**
 * The newsletter issues table, newest first as the read returns them. The
 * per-row Cancel launches the registered inverse-bearing op through the
 * OpModal — there is no bespoke confirm dialog.
 */
export function IssuesTable({
  rows,
}: Readonly<{ rows: readonly NewsletterIssueWire[] }>): React.JSX.Element {
  return (
    <DenseTable testId={TEST_IDS.adminNewsletterTable} headers={HEADERS}>
      {rows.map((row) => (
        <IssueRow key={row.id} row={row} />
      ))}
    </DenseTable>
  );
}
