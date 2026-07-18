import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { FeedbackInboxScreen } from './feedback-inbox-screen.js';
import type { FeedbackFilter } from '@/hooks/use-feedback';
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

const FULL_BODY_A =
  'The composer freezes when I paste a very long message and then hit send twice.';
const FULL_BODY_B = 'Add a keyboard shortcut for jumping to the newest message in a long thread.';

function fullBodyOf(id: string): string {
  return id === ROW_B.id ? FULL_BODY_B : FULL_BODY_A;
}

function detailOf(id: string): Record<string, unknown> {
  const row = id === ROW_B.id ? ROW_B : ROW_A;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    body: fullBodyOf(id),
    createdAt: row.createdAt,
    userId: row.userId,
  };
}

type JsonBody = Record<string, unknown>;

function stubApi(handler: (url: string) => JsonBody | Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
    const result = handler(requestUrl(input));
    return Promise.resolve(result instanceof Response ? result : Response.json(result));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function pageHandler(rows: readonly FeedbackInboxRowWire[]): (url: string) => JsonBody {
  return (url) => {
    if (url.includes('/admin/ops')) return CATALOG;
    const detailMatch = /\/admin\/feedback\/([^/?]+)/.exec(url);
    if (detailMatch) return detailOf(detailMatch[1]!);
    return { rows, nextCursor: null };
  };
}

function Harness(): React.JSX.Element {
  const [filter, setFilter] = React.useState<FeedbackFilter>({});
  const [expandedId, setExpandedId] = React.useState<string | undefined>();
  return (
    <FeedbackInboxScreen
      filter={filter}
      onFilterChange={setFilter}
      expandedId={expandedId}
      onExpandChange={setExpandedId}
    />
  );
}

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <Harness />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('FeedbackInboxScreen', () => {
  it('renders an inbox table row per feedback', async () => {
    stubApi(pageHandler([ROW_A, ROW_B]));
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminFeedbackTable);
    expect(within(table).getByText('The composer freezes when…')).toBeInTheDocument();
    expect(within(table).getByText('Add a keyboard shortcut for…')).toBeInTheDocument();
    expect(within(table).getByText('bug')).toBeInTheDocument();
  });

  it('teaches in the empty state', async () => {
    stubApi(pageHandler([]));
    renderScreen();
    expect(await screen.findByTestId(TEST_IDS.adminFeedbackEmpty)).toBeInTheDocument();
  });

  it('shows a loading state while the first page is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    );
    renderScreen();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows a plain error state on a non-429 failure', async () => {
    stubApi((url) => {
      if (url.includes('/admin/ops')) return CATALOG;
      return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
    });
    renderScreen();
    expect(await screen.findByText('Failed to load the feedback inbox.')).toBeInTheDocument();
  });

  it('shows the rate-limited notice on a 429', async () => {
    stubApi((url) => {
      if (url.includes('/admin/ops')) return CATALOG;
      return Response.json(
        { code: 'RATE_LIMITED', details: { retryAfterSeconds: 9 } },
        { status: 429 }
      );
    });
    renderScreen();
    expect(await screen.findByTestId(TEST_IDS.adminRateLimited)).toBeInTheDocument();
  });

  it('retries a rate-limited read from the notice', async () => {
    let limited = true;
    const fetchMock = stubApi((url) => {
      if (url.includes('/admin/ops')) return CATALOG;
      if (limited) {
        return Response.json(
          { code: 'RATE_LIMITED', details: { retryAfterSeconds: 30 } },
          { status: 429 }
        );
      }
      return { rows: [ROW_A], nextCursor: null };
    });
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminRateLimited);
    limited = false;

    await userEvent.click(screen.getByTestId(TEST_IDS.adminRateLimitedRetry));
    await screen.findByTestId(TEST_IDS.adminFeedbackTable);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('loads more with the cursor', async () => {
    stubApi((url) => {
      if (url.includes('/admin/ops')) return CATALOG;
      if (url.includes('cursor=')) return { rows: [ROW_B], nextCursor: null };
      return { rows: [ROW_A], nextCursor: ROW_A.id };
    });
    renderScreen();
    await screen.findByText('The composer freezes when…');

    await userEvent.click(screen.getByTestId(TEST_IDS.adminFeedbackLoadMore));
    await waitFor(() => {
      expect(screen.getByText('Add a keyboard shortcut for…')).toBeInTheDocument();
    });
  });

  it('narrows the inbox query when a status tab is selected', async () => {
    const fetchMock = stubApi(pageHandler([ROW_A]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminFeedbackTable);

    const tabs = screen.getByTestId(TEST_IDS.adminFeedbackTabs);
    await userEvent.click(within(tabs).getByRole('button', { name: /triaged/i }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes('status=triaged'))
      ).toBe(true);
    });
  });

  it('clears the filter when the all tab is selected', async () => {
    const fetchMock = stubApi(pageHandler([ROW_A]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminFeedbackTable);

    const tabs = screen.getByTestId(TEST_IDS.adminFeedbackTabs);
    await userEvent.click(within(tabs).getByRole('button', { name: /triaged/i }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes('status=triaged'))
      ).toBe(true);
    });

    await userEvent.click(within(tabs).getByRole('button', { name: /^all$/i }));
    await waitFor(() => {
      expect(within(tabs).getByRole('button', { name: /^all$/i })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });
  });

  it('keeps the open row when a non-Escape key is pressed', async () => {
    stubApi(pageHandler([ROW_A]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminFeedbackTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminFeedbackExpand));
    await screen.findByTestId(TEST_IDS.adminFeedbackDetail);
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByTestId(TEST_IDS.adminFeedbackDetail)).toBeInTheDocument();
  });

  it('expands a row to reveal the full body via the lazy detail read', async () => {
    const fetchMock = stubApi(pageHandler([ROW_A]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminFeedbackTable);
    // No detail read fires before the row is expanded.
    expect(
      fetchMock.mock.calls.some((call) =>
        requestUrl(call[0]).includes(`/admin/feedback/${ROW_A.id}`)
      )
    ).toBe(false);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminFeedbackExpand));
    const detail = await screen.findByTestId(TEST_IDS.adminFeedbackDetail);
    expect(await within(detail).findByText(FULL_BODY_A)).toBeInTheDocument();

    const detailCalls = fetchMock.mock.calls.filter((call) =>
      requestUrl(call[0]).includes(`/admin/feedback/${ROW_A.id}`)
    );
    expect(detailCalls).toHaveLength(1);
  });

  it('collapses the previously open row when another is expanded (single-open)', async () => {
    stubApi(pageHandler([ROW_A, ROW_B]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminFeedbackTable);

    const toggles = screen.getAllByTestId(TEST_IDS.adminFeedbackExpand);
    await userEvent.click(toggles[0]!);
    expect(await screen.findByText(FULL_BODY_A)).toBeInTheDocument();

    await userEvent.click(screen.getAllByTestId(TEST_IDS.adminFeedbackExpand)[1]!);
    expect(await screen.findByText(FULL_BODY_B)).toBeInTheDocument();
    expect(screen.queryByText(FULL_BODY_A)).not.toBeInTheDocument();
    expect(screen.getAllByTestId(TEST_IDS.adminFeedbackDetail)).toHaveLength(1);
  });

  it('collapses the open row on the chevron toggle', async () => {
    stubApi(pageHandler([ROW_A]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminFeedbackTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminFeedbackExpand));
    await screen.findByTestId(TEST_IDS.adminFeedbackDetail);
    await userEvent.click(screen.getByTestId(TEST_IDS.adminFeedbackExpand));
    expect(screen.queryByTestId(TEST_IDS.adminFeedbackDetail)).not.toBeInTheDocument();
  });

  it('collapses the open row on Escape', async () => {
    stubApi(pageHandler([ROW_A]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminFeedbackTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminFeedbackExpand));
    await screen.findByTestId(TEST_IDS.adminFeedbackDetail);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId(TEST_IDS.adminFeedbackDetail)).not.toBeInTheDocument();
  });

  it('starts the set-status op through the OpModal with the feedback id prefilled', async () => {
    stubApi(pageHandler([ROW_A]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminFeedbackTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminFeedbackExpand));
    await screen.findByTestId(TEST_IDS.adminFeedbackDetail);
    await userEvent.click(screen.getByRole('button', { name: /set status/i }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Set feedback status')).toBeInTheDocument();
    expect(within(modal).getByLabelText('feedbackId')).toHaveValue(ROW_A.id);
  });
});
