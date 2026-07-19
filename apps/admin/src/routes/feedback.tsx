import * as React from 'react';
import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { FeedbackStatus } from '@hushbox/shared';
import { FeedbackInboxScreen } from '@/components/feedback/feedback-inbox-screen';

// Status filter and the inspected row live in the URL so a filtered/opened
// inbox view is shareable and survives reload; an unknown status or an empty
// selection is dropped rather than fed to the query.
const selectedSchema = z.string().min(1);

export interface FeedbackSearch {
  readonly status?: z.infer<typeof FeedbackStatus> | undefined;
  readonly selected?: string | undefined;
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
  validateSearch: (search: Record<string, unknown>): FeedbackSearch => {
    const status = FeedbackStatus.safeParse(search['status']);
    const selected = selectedSchema.safeParse(search['selected']);
    return {
      ...(status.success ? { status: status.data } : {}),
      ...(selected.success ? { selected: selected.data } : {}),
    };
  },
  component: Screen,
});
