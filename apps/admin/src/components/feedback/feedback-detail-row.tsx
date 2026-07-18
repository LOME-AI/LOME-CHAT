import * as React from 'react';
import { AnimatedHeight, Button } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { useFeedbackDetail } from '@/hooks/use-feedback';
import { CopyableId } from '@/components/util/copyable-id';
import type { FeedbackInboxRowWire } from '@hushbox/shared';

function DetailFact({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** The full message body. Mounting this component is what triggers the single
 * audited detail read — it never runs until the row is expanded. */
function DetailBody({ id }: Readonly<{ id: string }>): React.JSX.Element {
  const detail = useFeedbackDetail(id);
  if (detail.isPending) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (detail.isError) {
    return <p className="text-destructive text-sm">Failed to load the message.</p>;
  }
  return <p className="text-sm break-all whitespace-pre-wrap">{detail.data.body}</p>;
}

/**
 * The feedback inbox's inline detail row: a sibling `<tr>` dropped beneath the
 * expanded preview row. The `<tr>`/`<td>` stay plain table markup; the drop-down
 * animation lives on the `AnimatedHeight` inside the `<td>`. Rendered only while
 * expanded, so the audited detail read fires exactly once per expand.
 */
export function FeedbackDetailRow({
  row,
  columnCount,
}: Readonly<{
  row: FeedbackInboxRowWire;
  columnCount: number;
}>): React.JSX.Element {
  const runOp = useRunOp();
  return (
    <tr data-testid={TEST_IDS.adminFeedbackDetail} className="border-border bg-card border-b">
      <td colSpan={columnCount} className="p-0">
        <AnimatedHeight>
          <div className="flex min-w-0 flex-col gap-3 p-3">
            <dl className="flex flex-col gap-2 sm:flex-row sm:gap-6">
              <DetailFact label="Feedback">
                <CopyableId value={row.id} label="feedback id" />
              </DetailFact>
              <DetailFact label="Status">
                <span className="font-mono text-xs">{row.status}</span>
              </DetailFact>
              <DetailFact label="From user">
                <CopyableId value={row.userId} label="user id" />
              </DetailFact>
            </dl>
            <div>
              <h3 className="text-muted-foreground mb-1 text-xs font-semibold uppercase">
                Message
              </h3>
              <DetailBody id={row.id} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  runOp({ opName: 'feedback.setStatus', initialValues: { feedbackId: row.id } });
                }}
              >
                Set status
              </Button>
            </div>
          </div>
        </AnimatedHeight>
      </td>
    </tr>
  );
}
