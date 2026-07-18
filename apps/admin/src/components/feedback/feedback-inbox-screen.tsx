import * as React from 'react';
import { Button, cn } from '@hushbox/ui';
import { TEST_IDS, FEEDBACK_STATUSES, type FeedbackStatus } from '@hushbox/shared';
import { useFeedbackInbox, type FeedbackFilter } from '@/hooks/use-feedback';
import { RateLimitedNotice } from '@/components/util/rate-limited-notice';
import { retryAfterSecondsOf } from '@/lib/rate-limited';
import { FeedbackTable } from './feedback-table.js';
import type { FeedbackInboxRowWire } from '@hushbox/shared';

interface FeedbackInboxScreenProps {
  /** The active status filter — owned by the route's URL search params. */
  readonly filter: FeedbackFilter;
  readonly onFilterChange: (next: FeedbackFilter) => void;
  /** The expanded row's id — owned by the URL so a drilled-in view is shareable. */
  readonly expandedId?: string | undefined;
  readonly onExpandChange: (id?: string) => void;
}

type StatusTab = 'all' | FeedbackStatus;

const STATUS_TABS: readonly StatusTab[] = ['all', ...FEEDBACK_STATUSES];

function StatusTabs({
  active,
  onSelect,
}: Readonly<{
  active: StatusTab;
  onSelect: (tab: StatusTab) => void;
}>): React.JSX.Element {
  return (
    <div
      data-testid={TEST_IDS.adminFeedbackTabs}
      role="group"
      aria-label="Filter feedback by status"
      className="flex flex-wrap gap-1"
    >
      {STATUS_TABS.map((tab) => (
        <Button
          key={tab}
          size="sm"
          variant={active === tab ? 'secondary' : 'ghost'}
          aria-pressed={active === tab}
          className={cn('font-mono text-xs')}
          onClick={() => {
            onSelect(tab);
          }}
        >
          {tab.replace('_', ' ')}
        </Button>
      ))}
    </div>
  );
}

function InboxBody({
  query,
  rows,
  expandedId,
  onToggle,
}: Readonly<{
  query: ReturnType<typeof useFeedbackInbox>;
  rows: readonly FeedbackInboxRowWire[];
  expandedId: string | undefined;
  onToggle: (id: string) => void;
}>): React.JSX.Element {
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
    return <p className="text-destructive text-sm">Failed to load the feedback inbox.</p>;
  }
  if (rows.length === 0) {
    return (
      <p data-testid={TEST_IDS.adminFeedbackEmpty} className="text-muted-foreground text-sm">
        No feedback matches this view. Every in-app submission lands here, so an empty result means
        the status filter is too narrow, not that nothing was sent.
      </p>
    );
  }
  return (
    <>
      <FeedbackTable rows={rows} expandedId={expandedId} onToggle={onToggle} />
      {query.hasNextPage ? (
        <div>
          <Button
            data-testid={TEST_IDS.adminFeedbackLoadMore}
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
 * The feedback inbox: URL-owned status tabs over the dense preview table. A
 * single row expands in place to reveal the full message (via the audited detail
 * read) and the triage op; expanding one collapses any other, and Escape
 * collapses the open row.
 */
export function FeedbackInboxScreen({
  filter,
  onFilterChange,
  expandedId,
  onExpandChange,
}: FeedbackInboxScreenProps): React.JSX.Element {
  const query = useFeedbackInbox(filter);
  const rows = React.useMemo(
    () => query.data?.pages.flatMap((page) => page.rows) ?? [],
    [query.data]
  );
  // Only expand a row that is actually loaded, so a stale deep-link id collapses
  // rather than firing a detail read for an off-screen row.
  const expanded = rows.find((row) => row.id === expandedId)?.id;

  const toggle = React.useCallback(
    (id: string) => {
      onExpandChange(id === expanded ? undefined : id);
    },
    [expanded, onExpandChange]
  );

  React.useEffect(() => {
    if (expanded === undefined) {
      return;
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onExpandChange();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
    };
  }, [expanded, onExpandChange]);

  return (
    <section className="flex flex-col gap-4 p-4">
      <h1 className="text-[1.2rem] font-bold">Feedback</h1>
      <StatusTabs
        active={filter.status ?? 'all'}
        onSelect={(tab) => {
          onFilterChange(tab === 'all' ? {} : { status: tab });
        }}
      />
      <InboxBody query={query} rows={rows} expandedId={expanded} onToggle={toggle} />
    </section>
  );
}
