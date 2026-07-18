import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { FeedbackTable } from './feedback-table.js';
import type { FeedbackInboxRowWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  ops: [
    {
      name: 'feedback.setStatus',
      title: 'Set feedback status',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'feedback.setStatus',
      fields: ['feedbackId', 'status', 'reason'],
    },
  ],
};

const ROW_A: FeedbackInboxRowWire = {
  id: '018f6b3a-0000-7000-8000-00000000000a',
  kind: 'bug',
  status: 'new',
  bodyPreview: 'The composer freezes when…',
  createdAt: '2026-07-14T09:00:00.000Z',
  userId: '018f6b3a-0000-7000-8000-000000000001',
};

const ROW_B: FeedbackInboxRowWire = {
  id: '018f6b3a-0000-7000-8000-00000000000b',
  kind: 'idea',
  status: 'triaged',
  bodyPreview: 'Add a keyboard shortcut for…',
  createdAt: '2026-07-14T08:00:00.000Z',
  userId: '018f6b3a-0000-7000-8000-000000000002',
};

const FULL_BODY = 'The composer freezes when I paste a very long message and then hit send twice.';

function detailOf(id: string): Record<string, unknown> {
  return {
    id,
    kind: 'bug',
    status: 'new',
    body: FULL_BODY,
    createdAt: ROW_A.createdAt,
    userId: ROW_A.userId,
  };
}

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('/admin/feedback/')) {
        const id = url.split('/admin/feedback/')[1]!.split('?')[0]!;
        return Promise.resolve(Response.json(detailOf(id)));
      }
      return Promise.resolve(Response.json(CATALOG));
    })
  );
}

function renderTable(props: {
  expandedId?: string | undefined;
  onToggle?: (id: string) => void;
}): void {
  stubApi();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <FeedbackTable
          rows={[ROW_A, ROW_B]}
          expandedId={props.expandedId}
          onToggle={props.onToggle ?? vi.fn()}
        />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('FeedbackTable', () => {
  it('renders a preview row per feedback', () => {
    renderTable({});
    const table = screen.getByTestId(TEST_IDS.adminFeedbackTable);
    expect(within(table).getByText('The composer freezes when…')).toBeInTheDocument();
    expect(within(table).getByText('Add a keyboard shortcut for…')).toBeInTheDocument();
    expect(within(table).getByText('idea')).toBeInTheDocument();
  });

  it('marks the chevron collapsed when no row is expanded', () => {
    renderTable({});
    for (const toggle of screen.getAllByTestId(TEST_IDS.adminFeedbackExpand)) {
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByTestId(TEST_IDS.adminFeedbackDetail)).not.toBeInTheDocument();
  });

  it('renders the detail row and an expanded chevron for the expanded row only', () => {
    renderTable({ expandedId: ROW_A.id });
    const toggles = screen.getAllByTestId(TEST_IDS.adminFeedbackExpand);
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'true');
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByTestId(TEST_IDS.adminFeedbackDetail)).toHaveLength(1);
  });

  it('calls onToggle with the row id when the chevron is clicked', async () => {
    const onToggle = vi.fn();
    renderTable({ onToggle });
    await userEvent.click(screen.getAllByTestId(TEST_IDS.adminFeedbackExpand)[0]!);
    expect(onToggle).toHaveBeenCalledWith(ROW_A.id);
  });
});
