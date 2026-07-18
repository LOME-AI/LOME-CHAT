import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { useNewsletterIssues } from '@/hooks/use-newsletter';
import { ComposePanel } from './compose-panel.js';
import { IssuesTable } from './issues-table.js';
import { LoadMoreButton } from './load-more-button.js';
import { SubscribersSection } from './subscribers-section.js';
import type { NewsletterIssueWire } from '@hushbox/shared';

function IssuesBody({
  query,
  rows,
}: Readonly<{
  query: ReturnType<typeof useNewsletterIssues>;
  rows: readonly NewsletterIssueWire[];
}>): React.JSX.Element {
  if (query.isPending) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (query.isError) {
    return <p className="text-destructive text-sm">Failed to load the issues table.</p>;
  }
  if (rows.length === 0) {
    return (
      <p data-testid={TEST_IDS.adminNewsletterEmpty} className="text-muted-foreground text-sm">
        No issues yet. Scheduling the first one above puts it here.
      </p>
    );
  }
  return (
    <>
      <IssuesTable rows={rows} />
      <LoadMoreButton
        testId={TEST_IDS.adminNewsletterLoadMore}
        hasNextPage={query.hasNextPage}
        pending={query.isFetchingNextPage}
        onLoadMore={() => {
          void query.fetchNextPage();
        }}
      />
    </>
  );
}

/**
 * The newsletter screen: compose (with live dispatch-path preview), the
 * issues table, and the subscribers section. Both mutations here — schedule
 * and cancel — run only through the OpModal grammar.
 */
export function NewsletterScreen(): React.JSX.Element {
  const issues = useNewsletterIssues();
  const rows = React.useMemo(
    () => issues.data?.pages.flatMap((page) => page.rows) ?? [],
    [issues.data]
  );
  return (
    <section className="flex flex-col gap-4 p-4">
      <h1 className="text-[1.2rem] font-bold">Newsletter</h1>
      <ComposePanel />
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Issues</h2>
        <IssuesBody query={issues} rows={rows} />
      </div>
      <SubscribersSection />
    </section>
  );
}
