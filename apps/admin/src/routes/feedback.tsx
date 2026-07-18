import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { FEEDBACK_STATUSES, type FeedbackStatus } from '@hushbox/shared';
import { FeedbackInboxScreen } from '@/components/feedback/feedback-inbox-screen';

export interface FeedbackSearch {
  readonly status?: FeedbackStatus | undefined;
  readonly selected?: string | undefined;
}

function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

function Screen(): React.JSX.Element {
  const { status, selected } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <FeedbackInboxScreen
      filter={status === undefined ? {} : { status }}
      onFilterChange={(next) => {
        void navigate({
          search: (previous) => ({ ...previous, status: next.status, selected: undefined }),
        });
      }}
      expandedId={selected}
      onExpandChange={(id) => {
        void navigate({ search: (previous) => ({ ...previous, selected: id }) });
      }}
    />
  );
}

export const Route = createFileRoute('/feedback')({
  // Status filter and the inspected row live in the URL so a filtered/opened
  // inbox view is shareable and survives reload; an invalid status or a
  // non-string selection is dropped rather than fed to the query.
  validateSearch: (search: Record<string, unknown>): FeedbackSearch => ({
    ...(isFeedbackStatus(search['status']) ? { status: search['status'] } : {}),
    ...(typeof search['selected'] === 'string' && search['selected'] !== ''
      ? { selected: search['selected'] }
      : {}),
  }),
  component: Screen,
});
