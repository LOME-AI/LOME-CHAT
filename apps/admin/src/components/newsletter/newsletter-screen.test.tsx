import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { NewsletterScreen } from './newsletter-screen.js';
import type { NewsletterIssueWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const STATS = {
  byStatus: { pending: 0, subscribed: 4, unsubscribed: 0, suppressed: 0 },
  bySuppressReason: { bounce: 0, complaint: 0 },
};

const ISSUE: NewsletterIssueWire = {
  id: '018f6b3a-0000-7000-8000-00000000000a',
  subject: 'July product notes',
  status: 'scheduled',
  scheduledAt: '2026-07-20T09:00:00.000Z',
  canceledAt: null,
  sentAt: null,
  recipientCount: null,
  sentCount: null,
  failedCount: null,
  createdBy: 'lome@lome-ai.com',
  createdAt: '2026-07-17T09:00:00.000Z',
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

function defaultHandler(rows: readonly NewsletterIssueWire[]): (url: string) => JsonBody {
  return (url) => {
    if (url.includes('/subscribers/stats')) return STATS;
    if (url.includes('/newsletter/issues')) return { rows, nextCursor: null };
    return { ops: [] };
  };
}

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <NewsletterScreen />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('NewsletterScreen', () => {
  it('composes heading, compose fields, issues, and subscribers sections', async () => {
    stubApi(defaultHandler([ISSUE]));
    renderScreen();
    expect(screen.getByRole('heading', { name: 'Newsletter' })).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminNewsletterSubject)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoad)).toBeInTheDocument();
    const table = await screen.findByTestId(TEST_IDS.adminNewsletterTable);
    expect(within(table).getByText('July product notes')).toBeInTheDocument();
  });

  it('teaches in the issues empty state', async () => {
    stubApi(defaultHandler([]));
    renderScreen();
    expect(await screen.findByTestId(TEST_IDS.adminNewsletterEmpty)).toBeInTheDocument();
  });

  it('shows an issues error state', async () => {
    stubApi((url) => {
      if (url.includes('/subscribers/stats')) return STATS;
      if (url.includes('/newsletter/issues')) {
        return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
      }
      return { ops: [] };
    });
    renderScreen();
    expect(await screen.findByText('Failed to load the issues table.')).toBeInTheDocument();
  });

  it('loads more issues with the cursor', async () => {
    const cursor = '018f6b3a-0000-7000-8000-00000000000b';
    const fetchMock = stubApi((url) => {
      if (url.includes('/subscribers/stats')) return STATS;
      if (url.includes('/newsletter/issues')) {
        if (url.includes('cursor=')) {
          return { rows: [{ ...ISSUE, id: cursor, subject: 'June recap' }], nextCursor: null };
        }
        return { rows: [ISSUE], nextCursor: cursor };
      }
      return { ops: [] };
    });
    renderScreen();
    await screen.findByText('July product notes');

    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterLoadMore));
    expect(await screen.findByText('June recap')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes(`cursor=${cursor}`))
      ).toBe(true);
    });
  });
});
