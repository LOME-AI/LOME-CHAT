import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { SubscribersSection } from './subscribers-section.js';
import type { NewsletterSubscriberWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const STATS = {
  byStatus: { pending: 2, subscribed: 40, unsubscribed: 3, suppressed: 1 },
  bySuppressReason: { bounce: 1, complaint: 0 },
};

const ROW: NewsletterSubscriberWire = {
  id: '018f6b3a-0000-7000-8000-000000000001',
  email: 'reader@example.com',
  status: 'subscribed',
  suppressReason: null,
  consentSource: 'marketing_site',
  consentIp: '203.0.113.9',
  consentTextVersion: '2026-07-17',
  createdAt: '2026-07-10T09:00:00.000Z',
  confirmedAt: '2026-07-10T09:05:00.000Z',
  unsubscribedAt: null,
  suppressedAt: null,
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

function defaultHandler(rows: readonly NewsletterSubscriberWire[]): (url: string) => JsonBody {
  return (url) => {
    if (url.includes('/subscribers/stats')) return STATS;
    return { rows, nextCursor: null };
  };
}

function renderSection(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SubscribersSection />
    </QueryClientProvider>
  );
}

describe('SubscribersSection', () => {
  it('renders the per-status and suppress-reason stat tiles', async () => {
    stubApi(defaultHandler([ROW]));
    renderSection();
    const stats = await screen.findByTestId(TEST_IDS.adminNewsletterStats);
    expect(within(stats).getByText('subscribed')).toBeInTheDocument();
    expect(within(stats).getByText('40')).toBeInTheDocument();
    expect(within(stats).getByText('bounce')).toBeInTheDocument();
  });

  it('never fires the audited subscribers read on mount', async () => {
    const fetchMock = stubApi(defaultHandler([ROW]));
    renderSection();
    await screen.findByTestId(TEST_IDS.adminNewsletterStats);
    const subscriberCalls = fetchMock.mock.calls
      .map((call) => requestUrl(call[0]))
      .filter((url) => url.includes('/subscribers') && !url.includes('/stats'));
    expect(subscriberCalls).toHaveLength(0);
  });

  it('loads the consent-evidence table only after the explicit audited affordance', async () => {
    const fetchMock = stubApi(defaultHandler([ROW]));
    renderSection();

    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoad));
    const table = await screen.findByTestId(TEST_IDS.adminNewsletterSubscribers);
    expect(within(table).getByText('reader@example.com')).toBeInTheDocument();
    expect(within(table).getByText('203.0.113.9')).toBeInTheDocument();
    expect(within(table).getByText('2026-07-17')).toBeInTheDocument();
    expect(within(table).getByText('marketing_site')).toBeInTheDocument();
    const subscriberCalls = fetchMock.mock.calls
      .map((call) => requestUrl(call[0]))
      .filter((url) => url.includes('/subscribers') && !url.includes('/stats'));
    expect(subscriberCalls).toHaveLength(1);
  });

  it('narrows the loaded list with the status filter', async () => {
    const fetchMock = stubApi(defaultHandler([ROW]));
    renderSection();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoad));
    await screen.findByTestId(TEST_IDS.adminNewsletterSubscribers);

    const filter = screen.getByTestId(TEST_IDS.adminNewsletterSubscribersFilter);
    await userEvent.click(within(filter).getByRole('button', { name: /suppressed/i }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes('status=suppressed'))
      ).toBe(true);
    });
  });

  it('pages the loaded list with the cursor', async () => {
    const cursor = '018f6b3a-0000-7000-8000-000000000002';
    stubApi((url) => {
      if (url.includes('/subscribers/stats')) return STATS;
      if (url.includes('cursor=')) {
        return { rows: [{ ...ROW, id: cursor, email: 'second@example.com' }], nextCursor: null };
      }
      return { rows: [ROW], nextCursor: cursor };
    });
    renderSection();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoad));
    await screen.findByText('reader@example.com');

    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoadMore));
    expect(await screen.findByText('second@example.com')).toBeInTheDocument();
  });

  it('teaches in the loaded-but-empty state', async () => {
    stubApi(defaultHandler([]));
    renderSection();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoad));
    expect(await screen.findByTestId(TEST_IDS.adminNewsletterSubscribersEmpty)).toBeInTheDocument();
  });

  it('shows the rate-limited notice on a 429 subscribers read', async () => {
    stubApi((url) => {
      if (url.includes('/subscribers/stats')) return STATS;
      return Response.json(
        { code: 'RATE_LIMITED', details: { retryAfterSeconds: 9 } },
        { status: 429 }
      );
    });
    renderSection();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoad));
    expect(await screen.findByTestId(TEST_IDS.adminRateLimited)).toBeInTheDocument();
  });

  it('retries a rate-limited subscribers read from the notice', async () => {
    let limited = true;
    stubApi((url) => {
      if (url.includes('/subscribers/stats')) return STATS;
      if (limited) {
        return Response.json(
          { code: 'RATE_LIMITED', details: { retryAfterSeconds: 30 } },
          { status: 429 }
        );
      }
      return { rows: [ROW], nextCursor: null };
    });
    renderSection();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoad));
    await screen.findByTestId(TEST_IDS.adminRateLimited);
    limited = false;

    await userEvent.click(screen.getByTestId(TEST_IDS.adminRateLimitedRetry));
    expect(await screen.findByText('reader@example.com')).toBeInTheDocument();
  });

  it('shows the suppress reason on a suppressed row and em-dashes unconfirmed', async () => {
    const suppressed = {
      ...ROW,
      id: '018f6b3a-0000-7000-8000-000000000003',
      email: 'bounced@example.com',
      status: 'suppressed' as const,
      suppressReason: 'bounce' as const,
      confirmedAt: null,
      suppressedAt: '2026-07-11T09:00:00.000Z',
    };
    stubApi(defaultHandler([suppressed]));
    renderSection();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoad));
    const table = await screen.findByTestId(TEST_IDS.adminNewsletterSubscribers);
    const row = within(table).getByText('bounced@example.com').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('bounce')).toBeInTheDocument();
    expect(within(row!).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows a plain error state when a read fails', async () => {
    stubApi((url) => {
      if (url.includes('/subscribers/stats')) return STATS;
      return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
    });
    renderSection();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoad));
    expect(await screen.findByText('Failed to load subscribers.')).toBeInTheDocument();
  });

  it('shows a stats error state without blanking the section', async () => {
    stubApi((url) => {
      if (url.includes('/subscribers/stats')) {
        return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
      }
      return { rows: [], nextCursor: null };
    });
    renderSection();
    expect(await screen.findByText('Failed to load subscriber stats.')).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminNewsletterSubscribersLoad)).toBeInTheDocument();
  });
});
