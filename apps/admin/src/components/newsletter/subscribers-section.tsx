import * as React from 'react';
import { Button, cn } from '@hushbox/ui';
import {
  TEST_IDS,
  NEWSLETTER_STATUSES,
  type NewsletterStatsWire,
  type NewsletterStatus,
  type NewsletterSubscriberWire,
} from '@hushbox/shared';
import { useNewsletterStats, useNewsletterSubscribers } from '@/hooks/use-newsletter';
import { RateLimitedNotice } from '@/components/util/rate-limited-notice';
import { retryAfterSecondsOf } from '@/lib/rate-limited';
import { CopyableId } from '@/components/util/copyable-id';
import { formatTime } from '@/lib/format-time';
import { DenseTable } from './dense-table.js';
import { LoadMoreButton } from './load-more-button.js';

const EM_DASH = '—';

type StatusTab = 'all' | NewsletterStatus;

const STATUS_TABS: readonly StatusTab[] = ['all', ...NEWSLETTER_STATUSES];

function StatTile({ label, count }: Readonly<{ label: string; count: number }>): React.JSX.Element {
  return (
    <div className="border-border flex flex-col rounded-md border px-2 py-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-sm">{count}</span>
    </div>
  );
}

function StatsTiles({ stats }: Readonly<{ stats: NewsletterStatsWire }>): React.JSX.Element {
  return (
    <div data-testid={TEST_IDS.adminNewsletterStats} className="flex flex-wrap gap-2">
      {Object.entries(stats.byStatus).map(([status, count]) => (
        <StatTile key={status} label={status} count={count} />
      ))}
      {Object.entries(stats.bySuppressReason).map(([reason, count]) => (
        <StatTile key={reason} label={reason} count={count} />
      ))}
    </div>
  );
}

function SubscriberRow({ row }: Readonly<{ row: NewsletterSubscriberWire }>): React.JSX.Element {
  return (
    <tr className="border-border border-b">
      <td className="py-1 pr-2">
        <CopyableId value={row.id} label="subscriber id" />
      </td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{row.email}</td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{row.status}</td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">
        {row.suppressReason ?? EM_DASH}
      </td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{row.consentSource}</td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{row.consentIp}</td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{row.consentTextVersion}</td>
      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{formatTime(row.createdAt)}</td>
      <td className="py-1 font-mono text-xs whitespace-nowrap">
        {row.confirmedAt === null ? EM_DASH : formatTime(row.confirmedAt)}
      </td>
    </tr>
  );
}

const HEADERS = [
  { label: 'Id' },
  { label: 'Email' },
  { label: 'Status' },
  { label: 'Suppressed' },
  { label: 'Consent source' },
  { label: 'Consent IP' },
  { label: 'Consent text' },
  { label: 'Signed up' },
  { label: 'Confirmed' },
] as const;

function SubscribersTable({
  rows,
}: Readonly<{ rows: readonly NewsletterSubscriberWire[] }>): React.JSX.Element {
  return (
    <DenseTable testId={TEST_IDS.adminNewsletterSubscribers} headers={HEADERS}>
      {rows.map((row) => (
        <SubscriberRow key={row.id} row={row} />
      ))}
    </DenseTable>
  );
}

function SubscribersBody({
  query,
  rows,
}: Readonly<{
  query: ReturnType<typeof useNewsletterSubscribers>;
  rows: readonly NewsletterSubscriberWire[];
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
    return <p className="text-destructive text-sm">Failed to load subscribers.</p>;
  }
  if (rows.length === 0) {
    return (
      <p
        data-testid={TEST_IDS.adminNewsletterSubscribersEmpty}
        className="text-muted-foreground text-sm"
      >
        No subscribers match this view.
      </p>
    );
  }
  return (
    <>
      <SubscribersTable rows={rows} />
      <LoadMoreButton
        testId={TEST_IDS.adminNewsletterSubscribersLoadMore}
        hasNextPage={query.hasNextPage}
        pending={query.isFetchingNextPage}
        onLoadMore={() => {
          void query.fetchNextPage();
        }}
      />
    </>
  );
}

function LoadedSubscribers(): React.JSX.Element {
  const [status, setStatus] = React.useState<NewsletterStatus | undefined>();
  const query = useNewsletterSubscribers(status === undefined ? {} : { status }, true);
  const rows = React.useMemo(
    () => query.data?.pages.flatMap((page) => page.rows) ?? [],
    [query.data]
  );
  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid={TEST_IDS.adminNewsletterSubscribersFilter}
        role="group"
        aria-label="Filter subscribers by status"
        className="flex flex-wrap gap-1"
      >
        {STATUS_TABS.map((tab) => {
          const active = tab === (status ?? 'all');
          return (
            <Button
              key={tab}
              size="sm"
              variant={active ? 'secondary' : 'ghost'}
              aria-pressed={active}
              className={cn('font-mono text-xs')}
              onClick={() => {
                setStatus(tab === 'all' ? undefined : tab);
              }}
            >
              {tab}
            </Button>
          );
        })}
      </div>
      <SubscribersBody query={query} rows={rows} />
    </div>
  );
}

/**
 * Subscriber stats over the audited consent-evidence list. The stats are an
 * unaudited aggregate and load with the screen; the per-person list writes
 * an audit row per page server-side, so it renders (and its query mounts)
 * only after the explicit load affordance — never on screen mount.
 */
export function SubscribersSection(): React.JSX.Element {
  const stats = useNewsletterStats();
  const [listRequested, setListRequested] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Subscribers</h2>
      {stats.isPending ? <p className="text-muted-foreground text-sm">Loading…</p> : null}
      {stats.isError ? (
        <p className="text-destructive text-sm">Failed to load subscriber stats.</p>
      ) : null}
      {stats.data === undefined ? null : <StatsTiles stats={stats.data} />}
      {listRequested ? (
        <LoadedSubscribers />
      ) : (
        <div>
          <Button
            data-testid={TEST_IDS.adminNewsletterSubscribersLoad}
            variant="outline"
            size="sm"
            onClick={() => {
              setListRequested(true);
            }}
          >
            Load subscribers (audited)
          </Button>
        </div>
      )}
    </div>
  );
}
