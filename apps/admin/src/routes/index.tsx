import * as React from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useDashboard } from '@/hooks/use-dashboard';
import { AuditActionsTable } from '@/components/audit/audit-actions-table';
import { UserSearch } from '@/components/dashboard/user-search';
import { RateLimitedNotice } from '@/components/util/rate-limited-notice';
import { retryAfterSecondsOf } from '@/lib/rate-limited';
import type { DashboardWire } from '@hushbox/shared';

function StatValue({
  value,
  attention,
}: Readonly<{ value: number; attention?: boolean | undefined }>): React.JSX.Element {
  return (
    <dd className={cn('font-mono text-xl tabular-nums', attention === true && 'text-destructive')}>
      {value}
    </dd>
  );
}

const TILE_CLASS = 'bg-card flex flex-col gap-0.5 p-3';

/**
 * The health strip: counts over charts, derived only from what the wire
 * provides (jobs counts + the recent-actions feed). Auditor statuses and
 * failed payments are deferred server reads and deliberately absent.
 */
function HealthTiles({ data }: Readonly<{ data: DashboardWire }>): React.JSX.Element {
  const today = new Date().toISOString().slice(0, 10);
  const actionsToday = data.recentActions.filter(
    (action) => action.createdAt.slice(0, 10) === today
  ).length;
  return (
    <dl
      data-testid={TEST_IDS.adminDashboardTiles}
      className="border-border grid grid-cols-1 gap-px overflow-hidden rounded-md border min-[480px]:grid-cols-2 sm:grid-cols-4"
    >
      <Link to="/jobs" className={cn(TILE_CLASS, 'hover:bg-accent')}>
        <dt className="text-muted-foreground text-xs uppercase">Dead jobs</dt>
        <StatValue value={data.jobs.dead} attention={data.jobs.dead > 0} />
      </Link>
      <div className={TILE_CLASS}>
        <dt className="text-muted-foreground text-xs uppercase">Backlog</dt>
        <StatValue value={data.jobs.pending + data.jobs.running} />
        <span className="text-muted-foreground text-xs">pending + running</span>
      </div>
      <div className={TILE_CLASS}>
        <dt className="text-muted-foreground text-xs uppercase">Discarded</dt>
        <StatValue value={data.jobs.discarded} />
      </div>
      <div className={TILE_CLASS}>
        <dt className="text-muted-foreground text-xs uppercase">Actions today</dt>
        <StatValue value={actionsToday} />
      </div>
    </dl>
  );
}

function DashboardBody({
  query,
}: Readonly<{ query: ReturnType<typeof useDashboard> }>): React.JSX.Element {
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
    return <p className="text-destructive text-sm">Failed to load the dashboard.</p>;
  }
  return (
    <>
      <HealthTiles data={query.data} />
      <div data-testid={TEST_IDS.adminDashboardRecent}>
        <h2 className="text-muted-foreground mb-1 text-xs font-semibold uppercase">
          Recent admin actions
        </h2>
        <AuditActionsTable rows={query.data.recentActions} />
      </div>
    </>
  );
}

function Dashboard(): React.JSX.Element {
  const query = useDashboard();
  return (
    <section className="flex flex-col gap-4 p-4">
      <h1 className="text-[1.2rem] font-bold">Dashboard</h1>
      <UserSearch />
      <DashboardBody query={query} />
    </section>
  );
}

export const Route = createFileRoute('/')({
  component: Dashboard,
});
