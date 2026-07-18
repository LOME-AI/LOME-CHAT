import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { requestUrl } from '@/test-utils/request-url';
import {
  newsletterKeys,
  renderNewsletterHtml,
  useNewsletterIssues,
  useNewsletterStats,
  useNewsletterSubscribers,
} from './use-newsletter.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ISSUE_ROW = {
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

const SUBSCRIBER_ROW = {
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

const STATS = {
  byStatus: { pending: 2, subscribed: 40, unsubscribed: 3, suppressed: 1 },
  bySuppressReason: { bounce: 1, complaint: 0 },
};

type FetchInput = string | URL | Request;

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('newsletterKeys', () => {
  it('namespaces every newsletter key under admin', () => {
    expect(newsletterKeys.all).toEqual(['admin', 'newsletter']);
    expect(newsletterKeys.issues()).toEqual(['admin', 'newsletter', 'issues']);
    expect(newsletterKeys.stats()).toEqual(['admin', 'newsletter', 'stats']);
    expect(newsletterKeys.subscribers({ status: 'subscribed' })).toEqual([
      'admin',
      'newsletter',
      'subscribers',
      'subscribed',
    ]);
    expect(newsletterKeys.subscribers({})).toEqual(['admin', 'newsletter', 'subscribers', 'all']);
  });
});

describe('useNewsletterIssues', () => {
  it('fetches one issues page through the typed client', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(Response.json({ rows: [ISSUE_ROW], nextCursor: null }, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useNewsletterIssues(), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.pages[0]?.rows[0]?.id).toBe(ISSUE_ROW.id);
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain('/api/admin/newsletter/issues');
  });

  it('pages with the cursor and reports hasNextPage from nextCursor', async () => {
    const cursor = '018f6b3a-0000-7000-8000-00000000000b';
    const fetchMock = vi.fn((input: FetchInput, _init?: RequestInit) => {
      const first = !requestUrl(input).includes('cursor=');
      return Promise.resolve(
        Response.json(
          first
            ? { rows: [ISSUE_ROW], nextCursor: cursor }
            : { rows: [{ ...ISSUE_ROW, id: cursor }], nextCursor: null },
          { status: 200 }
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useNewsletterIssues(), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();
    await waitFor(() => {
      expect(result.current.data?.pages).toHaveLength(2);
    });
    expect(result.current.hasNextPage).toBe(false);
    expect(requestUrl(fetchMock.mock.calls[1]![0])).toContain(`cursor=${cursor}`);
  });

  it('rejects a drifting issues shape loudly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [{ id: 1 }] }, { status: 200 })))
    );
    const { result } = renderHook(() => useNewsletterIssues(), { wrapper });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useNewsletterStats', () => {
  it('fetches the per-status and per-suppress-reason counts', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(Response.json(STATS, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useNewsletterStats(), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.byStatus.subscribed).toBe(40);
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(
      '/api/admin/newsletter/subscribers/stats'
    );
  });

  it('rejects a drifting stats shape loudly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ byStatus: {} }, { status: 200 })))
    );
    const { result } = renderHook(() => useNewsletterStats(), { wrapper });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useNewsletterSubscribers', () => {
  it('stays idle until explicitly enabled — the audited read is user-initiated', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useNewsletterSubscribers({}, false), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches one subscribers page with the status filter once enabled', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(Response.json({ rows: [SUBSCRIBER_ROW], nextCursor: null }, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useNewsletterSubscribers({ status: 'subscribed' }, true), {
      wrapper,
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.pages[0]?.rows[0]?.email).toBe(SUBSCRIBER_ROW.email);
    const url = requestUrl(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/admin/newsletter/subscribers');
    expect(url).toContain('status=subscribed');
  });

  it('pages with the cursor', async () => {
    const cursor = '018f6b3a-0000-7000-8000-000000000002';
    const fetchMock = vi.fn((input: FetchInput, _init?: RequestInit) => {
      const first = !requestUrl(input).includes('cursor=');
      return Promise.resolve(
        Response.json(
          first
            ? { rows: [SUBSCRIBER_ROW], nextCursor: cursor }
            : { rows: [{ ...SUBSCRIBER_ROW, id: cursor }], nextCursor: null },
          { status: 200 }
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useNewsletterSubscribers({}, true), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.hasNextPage).toBe(true);
    await result.current.fetchNextPage();
    await waitFor(() => {
      expect(result.current.data?.pages).toHaveLength(2);
    });
    expect(requestUrl(fetchMock.mock.calls[1]![0])).toContain(`cursor=${cursor}`);
  });

  it('rejects a drifting subscribers shape loudly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [{ id: 1 }] }, { status: 200 })))
    );
    const { result } = renderHook(() => useNewsletterSubscribers({}, true), { wrapper });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('renderNewsletterHtml', () => {
  it('posts the draft to the render endpoint and returns the html verbatim', async () => {
    const html = '<h1>July product notes</h1><p>hello</p>';
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(Response.json({ html }, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const rendered = await renderNewsletterHtml({
      subject: 'July product notes',
      bodyMarkdown: '# July product notes\n\nhello',
    });
    expect(rendered).toBe(html);
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain('/api/admin/newsletter/render');
    const init = fetchMock.mock.calls[0]![1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      subject: 'July product notes',
      bodyMarkdown: '# July product notes\n\nhello',
    });
  });

  it('sends a fresh Idempotency-Key per render request', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(Response.json({ html: '<p>x</p>' }, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    await renderNewsletterHtml({ subject: 's', bodyMarkdown: 'b' });
    await renderNewsletterHtml({ subject: 's', bodyMarkdown: 'b' });

    const keys = fetchMock.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get('idempotency-key')
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('throws the ApiError code on a failed render', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'VALIDATION' }, { status: 400 })))
    );
    await expect(renderNewsletterHtml({ subject: 's', bodyMarkdown: 'b' })).rejects.toThrow(
      'VALIDATION'
    );
  });

  it('rejects a drifting render shape loudly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ nope: true }, { status: 200 })))
    );
    await expect(renderNewsletterHtml({ subject: 's', bodyMarkdown: 'b' })).rejects.toThrow();
  });
});
