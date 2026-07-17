import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { JobsScreen } from './jobs-screen.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const COUNTS = { pending: 2, running: 1, dead: 3, discarded: 1 };

const DEAD_JOB = {
  id: '018f6b3a-0000-7000-8000-00000000000a',
  type: 'media.reclaimUser.v1',
  shard: 'bulk',
  status: 'dead',
  discarded: false,
  failures: 8,
  claims: 9,
  payload: { userId: '018f6b3a-0000-7000-8000-000000000001' },
  errors: [
    { at: '2026-07-14T09:30:00.000Z', claim: 1, error: 'storage unavailable' },
    { at: '2026-07-14T10:00:00.000Z', claim: 2, error: 'storage still unavailable' },
  ],
  nextAttemptAt: '2026-07-14T11:00:00.000Z',
  createdAt: '2026-07-14T09:00:00.000Z',
  finishedAt: null,
};

const DISCARDED_JOB = {
  ...DEAD_JOB,
  id: '018f6b3a-0000-7000-8000-00000000000b',
  discarded: true,
};

const PENDING_JOB = {
  ...DEAD_JOB,
  id: '018f6b3a-0000-7000-8000-00000000000c',
  status: 'pending',
  errors: [],
};

const CATALOG = {
  ops: [
    {
      name: 'job.redrive',
      title: 'Redrive dead job',
      kind: 'mutation',
      effectClass: 'ephemeral',
      inverse: null,
      fields: ['jobId', 'reason'],
    },
    {
      name: 'job.discard',
      title: 'Discard dead job',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'job.restore',
      fields: ['jobId', 'reason'],
    },
    {
      name: 'job.restore',
      title: 'Restore discarded job',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'job.discard',
      fields: ['jobId', 'reason'],
    },
  ],
};

type JsonBody = Record<string, unknown>;

function stubApi(handler: (url: string) => JsonBody | Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
    const result = handler(requestUrl(input));
    return Promise.resolve(result instanceof Response ? result : Response.json(result));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function defaultHandler(rows: readonly JsonBody[]): (url: string) => JsonBody {
  return (url) => {
    if (url.includes('/admin/dashboard')) return { jobs: COUNTS, recentActions: [] };
    if (url.includes('/admin/ops')) return CATALOG;
    return { rows, nextCursor: null };
  };
}

function renderScreen(): { queryClient: QueryClient } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <OpModalProvider>
        <JobsScreen />
      </OpModalProvider>
    </QueryClientProvider>
  );
  return { queryClient };
}

describe('JobsScreen', () => {
  it('renders the queue table with live tab counts from the dashboard read', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(within(table).getByText('media.reclaimUser.v1')).toBeInTheDocument();
    expect(within(table).getByText('8/9')).toBeInTheDocument();
    expect(within(table).getByText('storage still unavailable')).toBeInTheDocument();

    const tabs = screen.getByTestId(TEST_IDS.adminJobsTabs);
    await waitFor(() => {
      expect(within(tabs).getByRole('button', { name: /Dead\s*3/ })).toBeInTheDocument();
    });
    expect(within(tabs).getByRole('button', { name: /Pending\s*2/ })).toBeInTheDocument();
  });

  it('filters by status tab and by exact type', async () => {
    const fetchMock = stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByRole('button', { name: /^Dead/ }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes('status=dead'))).toBe(
        true
      );
    });

    await userEvent.type(
      screen.getByTestId(TEST_IDS.adminJobsTypeFilter),
      'payment.verify.v1{enter}'
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes('type=payment.verify.v1'))
      ).toBe(true);
    });
  });

  it('keeps the type filter placeholder short enough for narrow viewports', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    const input = await screen.findByTestId(TEST_IDS.adminJobsTypeFilter);
    expect(input).toHaveAttribute('placeholder', 'Exact type');
  });

  it('requests status=discarded when the Discarded tab is selected', async () => {
    const fetchMock = stubApi(defaultHandler([DISCARDED_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByRole('button', { name: /^Discarded/ }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes('status=discarded'))
      ).toBe(true);
    });
  });

  it('marks the Dead tab count as attention styling while dead rows exist', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();

    const tabs = screen.getByTestId(TEST_IDS.adminJobsTabs);
    const deadTab = await waitFor(() => within(tabs).getByRole('button', { name: /Dead\s*3/ }));
    const count = within(deadTab).getByText('3');
    expect(count).toHaveClass('text-destructive');
    // A tab without the dead-as-inbox contract stays muted.
    const pendingTab = within(tabs).getByRole('button', { name: /Pending\s*2/ });
    expect(within(pendingTab).getByText('2')).toHaveClass('text-muted-foreground');
  });

  it('expands a row to show the payload JSON and the error history timeline', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobExpand));
    const detail = screen.getByTestId(TEST_IDS.adminJobDetail);
    expect(within(detail).getByTestId(TEST_IDS.adminJobPayload).textContent).toContain(
      '018f6b3a-0000-7000-8000-000000000001'
    );
    const errors = within(detail).getByTestId(TEST_IDS.adminJobErrors);
    expect(within(errors).getByText('claim 1')).toBeInTheDocument();
    expect(within(errors).getByText('storage unavailable')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobExpand));
    expect(screen.queryByTestId(TEST_IDS.adminJobDetail)).not.toBeInTheDocument();
  });

  it('shows an empty error history for a row with no errors', async () => {
    stubApi(defaultHandler([PENDING_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);
    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobExpand));
    expect(screen.getByText('No errors recorded.')).toBeInTheDocument();
  });

  it('starts the redrive op through the OpModal with the job id prefilled', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobRedrive));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Redrive dead job')).toBeInTheDocument();
    expect(within(modal).getByLabelText('jobId')).toHaveValue(DEAD_JOB.id);
  });

  it('offers Discard on a dead row and Restore on a discarded row', async () => {
    stubApi(defaultHandler([DEAD_JOB, DISCARDED_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    expect(screen.getByTestId(TEST_IDS.adminJobDiscard)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobRestore));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Restore discarded job')).toBeInTheDocument();
  });

  it('offers no inline actions on a pending row', async () => {
    stubApi(defaultHandler([PENDING_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(screen.queryByTestId(TEST_IDS.adminJobRedrive)).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.adminJobRestore)).not.toBeInTheDocument();
  });

  it('loads the next cursor page from the Load more button', async () => {
    const cursor = '018f6b3a-0000-7000-8000-0000000000ff';
    stubApi((url) => {
      if (url.includes('/admin/dashboard')) return { jobs: COUNTS, recentActions: [] };
      if (url.includes('cursor=')) return { rows: [PENDING_JOB], nextCursor: null };
      return { rows: [DEAD_JOB], nextCursor: cursor };
    });
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobsLoadMore));
    await waitFor(() => {
      expect(screen.getAllByText('media.reclaimUser.v1')).toHaveLength(2);
    });
    expect(screen.queryByTestId(TEST_IDS.adminJobsLoadMore)).not.toBeInTheDocument();
  });

  it('teaches in the empty state', async () => {
    stubApi(defaultHandler([]));
    renderScreen();
    expect(await screen.findByTestId(TEST_IDS.adminJobsEmpty)).toHaveTextContent(/redriven/);
  });

  it('shows the rate-limited notice on a 429 queue read', async () => {
    stubApi((url) => {
      if (url.includes('/admin/dashboard')) return { jobs: COUNTS, recentActions: [] };
      return Response.json(
        { code: 'RATE_LIMITED', details: { retryAfterSeconds: 12 } },
        { status: 429 }
      );
    });
    renderScreen();
    expect(await screen.findByTestId(TEST_IDS.adminRateLimited)).toBeInTheDocument();
  });

  it('shows a plain error state on a non-429 failure', async () => {
    stubApi((url) => {
      if (url.includes('/admin/dashboard')) return { jobs: COUNTS, recentActions: [] };
      return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
    });
    renderScreen();
    expect(await screen.findByText('Failed to load the job queue.')).toBeInTheDocument();
  });

  it('invalidates the queue and counts on Refresh', async () => {
    const fetchMock = stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);
    const before = fetchMock.mock.calls.length;

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobsRefresh));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });
  });
});

describe('JobsScreen extras', () => {
  it('starts the discard op through the OpModal', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobDiscard));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Discard dead job')).toBeInTheDocument();
    expect(within(modal).getByLabelText('jobId')).toHaveValue(DEAD_JOB.id);
  });

  it('retries a rate-limited queue read from the notice', async () => {
    let limited = true;
    stubApi((url) => {
      if (url.includes('/admin/dashboard')) return { jobs: COUNTS, recentActions: [] };
      if (limited) {
        return Response.json(
          { code: 'RATE_LIMITED', details: { retryAfterSeconds: 30 } },
          { status: 429 }
        );
      }
      return { rows: [DEAD_JOB], nextCursor: null };
    });
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminRateLimited);
    limited = false;

    await userEvent.click(screen.getByTestId(TEST_IDS.adminRateLimitedRetry));
    expect(await screen.findByTestId(TEST_IDS.adminJobsTable)).toBeInTheDocument();
  });

  it('renders the dead tab without the inbox badge while counts are still loading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, _init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/admin/dashboard')) {
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(Response.json({ rows: [DEAD_JOB], nextCursor: null }));
      })
    );
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByRole('button', { name: 'Dead' }));
    await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(screen.queryByText(/need a decision/)).not.toBeInTheDocument();
  });
});
