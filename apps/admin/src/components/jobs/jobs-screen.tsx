import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge, Button, IconButton, Input, cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { dashboardKeys, useDashboard } from '@/hooks/use-dashboard';
import { jobsKeys, useJobsQueue, type JobStatusFilter } from '@/hooks/use-jobs';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { CopyableId } from '@/components/util/copyable-id';
import { RateLimitedNotice } from '@/components/util/rate-limited-notice';
import { retryAfterSecondsOf } from '@/lib/rate-limited';
import { formatTime } from '@/lib/format-time';
import type { AdminJobCountsWire, AdminJobRowWire } from '@hushbox/shared';

type StatusTab = 'all' | JobStatusFilter;

interface TabSpec {
  readonly value: StatusTab;
  readonly label: string;
  /** Live count from the dashboard read, where one exists for the status. */
  readonly countOf?: (counts: AdminJobCountsWire) => number;
  /** Dead-as-inbox: the tab demands attention while its count is nonzero. */
  readonly attention?: boolean;
}

// Succeeded and Cancelled carry no counts by design: the dashboard read's
// AdminJobCountsWire serializes only the attention buckets (pending,
// running, dead, discarded) — succeeded rows prune on retention, so a
// count would be a meaningless rolling window, and there is no dedicated
// counts endpoint.
const STATUS_TABS: readonly TabSpec[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending', countOf: (counts) => counts.pending },
  { value: 'running', label: 'Running', countOf: (counts) => counts.running },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'dead', label: 'Dead', countOf: (counts) => counts.dead, attention: true },
  { value: 'discarded', label: 'Discarded', countOf: (counts) => counts.discarded },
];

function StatusTabs({
  active,
  counts,
  onSelect,
}: Readonly<{
  active: StatusTab;
  counts: AdminJobCountsWire | undefined;
  onSelect: (tab: StatusTab) => void;
}>): React.JSX.Element {
  return (
    <div
      data-testid={TEST_IDS.adminJobsTabs}
      role="group"
      aria-label="Filter jobs by status"
      className="flex flex-wrap gap-1"
    >
      {STATUS_TABS.map((tab) => {
        const count =
          counts !== undefined && tab.countOf !== undefined ? tab.countOf(counts) : null;
        const attention = tab.attention === true && count !== null && count > 0;
        return (
          <Button
            key={tab.value}
            size="sm"
            variant={active === tab.value ? 'secondary' : 'ghost'}
            aria-pressed={active === tab.value}
            onClick={() => {
              onSelect(tab.value);
            }}
          >
            {tab.label}
            {count === null ? null : (
              <span
                className={cn(
                  'font-mono text-xs tabular-nums',
                  attention ? 'text-destructive font-semibold' : 'text-muted-foreground'
                )}
              >
                {count}
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}

/** The row's inline actions: dead rows are an inbox — redrive or discard;
 * discarded rows offer restore. All flow through the OpModal. */
function JobActions({ job }: Readonly<{ job: AdminJobRowWire }>): React.JSX.Element | null {
  const runOp = useRunOp();
  if (job.discarded) {
    return (
      <Button
        data-testid={TEST_IDS.adminJobRestore}
        size="sm"
        variant="outline"
        onClick={() => {
          runOp({ opName: 'job.restore', initialValues: { jobId: job.id } });
        }}
      >
        Restore
      </Button>
    );
  }
  if (job.status !== 'dead') {
    return null;
  }
  return (
    <span className="inline-flex gap-1">
      <Button
        data-testid={TEST_IDS.adminJobRedrive}
        size="sm"
        onClick={() => {
          runOp({ opName: 'job.redrive', initialValues: { jobId: job.id } });
        }}
      >
        Redrive
      </Button>
      <Button
        data-testid={TEST_IDS.adminJobDiscard}
        size="sm"
        variant="outline"
        className="text-destructive"
        onClick={() => {
          runOp({ opName: 'job.discard', initialValues: { jobId: job.id } });
        }}
      >
        Discard
      </Button>
    </span>
  );
}

const DETAIL_COLUMNS = 8;

/** Row expansion: the payload (pretty JSON) plus the per-attempt error history. */
function JobDetailRow({ job }: Readonly<{ job: AdminJobRowWire }>): React.JSX.Element {
  return (
    <tr data-testid={TEST_IDS.adminJobDetail} className="border-border bg-card border-b">
      <td colSpan={DETAIL_COLUMNS} className="p-2">
        <div className="flex flex-col gap-2">
          <div>
            <h3 className="text-muted-foreground mb-1 text-xs font-semibold uppercase">Payload</h3>
            <pre
              data-testid={TEST_IDS.adminJobPayload}
              className="border-border max-h-64 overflow-auto rounded-md border p-2 font-mono text-xs"
            >
              {JSON.stringify(job.payload, null, 2)}
            </pre>
          </div>
          <div data-testid={TEST_IDS.adminJobErrors}>
            <h3 className="text-muted-foreground mb-1 text-xs font-semibold uppercase">
              Error history
            </h3>
            {job.errors.length === 0 ? (
              <p className="text-muted-foreground text-sm">No errors recorded.</p>
            ) : (
              <ol className="flex flex-col gap-1">
                {job.errors.map((entry, index) => (
                  <li
                    key={`${entry.at}-${String(index)}`}
                    className="flex flex-wrap items-baseline gap-2 text-xs"
                  >
                    <span className="font-mono whitespace-nowrap">{formatTime(entry.at)}</span>
                    <span className="text-muted-foreground font-mono tabular-nums">
                      claim {entry.claim}
                    </span>
                    <span className="font-mono break-all">{entry.error}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

function JobRow({
  job,
  expanded,
  onToggle,
}: Readonly<{
  job: AdminJobRowWire;
  expanded: boolean;
  onToggle: () => void;
}>): React.JSX.Element {
  const lastError = job.errors.at(-1)?.error;
  return (
    <>
      <tr className="border-border border-b">
        <td className="py-1 pr-1">
          <IconButton
            data-testid={TEST_IDS.adminJobExpand}
            aria-label={expanded ? 'Collapse job details' : 'Expand job details'}
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
          <div className="flex flex-col">
            <span className="font-mono text-xs">{job.type}</span>
            <CopyableId value={job.id} label="job id" />
          </div>
        </td>
        <td className="py-1 pr-2 font-mono text-xs">{job.shard}</td>
        <td className="py-1 pr-2 font-mono text-xs">
          {job.status}
          {job.discarded ? ' (discarded)' : ''}
        </td>
        <td className="py-1 pr-2 text-right font-mono text-xs tabular-nums">
          {job.failures}/{job.claims}
        </td>
        <td className="text-muted-foreground max-w-64 truncate py-1 pr-2 font-mono text-xs">
          {lastError ?? ''}
        </td>
        <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">
          {formatTime(job.createdAt)}
        </td>
        <td className="py-1 text-right">
          <JobActions job={job} />
        </td>
      </tr>
      {expanded ? <JobDetailRow job={job} /> : null}
    </>
  );
}

function JobsTable({ rows }: Readonly<{ rows: readonly AdminJobRowWire[] }>): React.JSX.Element {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  return (
    <div className="overflow-x-auto">
      <table data-testid={TEST_IDS.adminJobsTable} className="w-full text-left text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-xs uppercase">
            <th className="py-1 pr-1 font-medium">
              <span className="sr-only">Expand</span>
            </th>
            <th className="py-1 pr-2 font-medium">Type</th>
            <th className="py-1 pr-2 font-medium">Shard</th>
            <th className="py-1 pr-2 font-medium">Status</th>
            <th className="py-1 pr-2 text-right font-medium">Failures/claims</th>
            <th className="py-1 pr-2 font-medium">Last error</th>
            <th className="py-1 pr-2 font-medium">Enqueued</th>
            <th className="py-1 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              expanded={expandedId === job.id}
              onToggle={() => {
                setExpandedId((current) => (current === job.id ? null : job.id));
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueueBody({
  query,
}: Readonly<{ query: ReturnType<typeof useJobsQueue> }>): React.JSX.Element {
  if (query.isPending) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (query.isError) {
    const retryAfter = retryAfterSecondsOf(query.error);
    if (retryAfter !== null) {
      return (
        <RateLimitedNotice
          retryAfterSeconds={retryAfter}
          resetKey={query.errorUpdatedAt}
          onRetry={() => {
            void query.refetch();
          }}
        />
      );
    }
    return <p className="text-destructive text-sm">Failed to load the job queue.</p>;
  }
  const rows = query.data.pages.flatMap((page) => page.rows);
  if (rows.length === 0) {
    return (
      <p data-testid={TEST_IDS.adminJobsEmpty} className="text-muted-foreground text-sm">
        No jobs match this view. Dead rows are an inbox: a job lands there when it exhausts its
        retries, and every one must be redriven (after fixing the cause) or discarded with a reason.
      </p>
    );
  }
  return (
    <>
      <JobsTable rows={rows} />
      {query.hasNextPage ? (
        <div>
          <Button
            data-testid={TEST_IDS.adminJobsLoadMore}
            variant="outline"
            size="sm"
            disabled={query.isFetchingNextPage}
            onClick={() => {
              void query.fetchNextPage();
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * The jobs queue screen: status tabs with live counts (from the dashboard
 * read — there is no dedicated counts endpoint), a type filter, and the
 * dense queue table with dead-as-inbox actions.
 */
export function JobsScreen(): React.JSX.Element {
  const [status, setStatus] = React.useState<StatusTab>('all');
  const [typeDraft, setTypeDraft] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState('');
  const dashboard = useDashboard();
  const queryClient = useQueryClient();
  const query = useJobsQueue({
    ...(status === 'all' ? {} : { status }),
    ...(typeFilter === '' ? {} : { type: typeFilter }),
  });
  return (
    <section className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[1.2rem] font-bold">Jobs</h1>
        <Button
          data-testid={TEST_IDS.adminJobsRefresh}
          size="sm"
          variant="outline"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: jobsKeys.all });
            void queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
          }}
        >
          Refresh
        </Button>
      </div>
      <StatusTabs active={status} counts={dashboard.data?.jobs} onSelect={setStatus} />
      <form
        className="flex max-w-sm items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setTypeFilter(typeDraft.trim());
        }}
      >
        <Input
          data-testid={TEST_IDS.adminJobsTypeFilter}
          value={typeDraft}
          onChange={(event) => {
            setTypeDraft(event.target.value);
          }}
          placeholder="Exact type"
          aria-label="Filter jobs by type"
          className="h-8 font-mono text-xs"
        />
        <Button type="submit" size="sm" variant="outline">
          Filter
        </Button>
      </form>
      <QueueBody query={query} />
      {status === 'dead' && (dashboard.data?.jobs.dead ?? 0) > 0 ? (
        <Badge variant="outline" className="text-destructive self-start">
          Dead rows need a decision: redrive or discard
        </Badge>
      ) : null}
    </section>
  );
}
