import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { requestUrl } from '@/test-utils/request-url';
import { jobsKeys, useJobsQueue } from './use-jobs.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const JOB_ROW = {
  id: '018f6b3a-0000-7000-8000-00000000000a',
  type: 'media.reclaimUser.v1',
  shard: 'bulk',
  status: 'dead',
  discarded: false,
  failures: 8,
  claims: 9,
  payload: { userId: 'u1' },
  errors: [{ at: '2026-07-14T10:00:00.000Z', claim: 1, error: 'storage unavailable' }],
  nextAttemptAt: '2026-07-14T11:00:00.000Z',
  createdAt: '2026-07-14T09:00:00.000Z',
  finishedAt: null,
};

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('jobsKeys', () => {
  it('namespaces the queue key under admin and keys by filter', () => {
    expect(jobsKeys.all).toEqual(['admin', 'jobs']);
    expect(jobsKeys.list({ status: 'dead', type: 'a.b.v1' })).toEqual([
      'admin',
      'jobs',
      'dead',
      'a.b.v1',
    ]);
    expect(jobsKeys.list({})).toEqual(['admin', 'jobs', 'all', '']);
  });
});

describe('useJobsQueue', () => {
  it('fetches one page through the typed client with the filter in the query', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(Response.json({ rows: [JOB_ROW], nextCursor: null }, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useJobsQueue({ status: 'dead', type: 'a.b.v1' }), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.pages[0]?.rows[0]?.id).toBe(JOB_ROW.id);
    const url = requestUrl(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/admin/jobs');
    expect(url).toContain('status=dead');
    expect(url).toContain('type=a.b.v1');
  });

  it('pages with the cursor and reports hasNextPage from nextCursor', async () => {
    const cursor = '018f6b3a-0000-7000-8000-00000000000b';
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      const first = !requestUrl(input).includes('cursor=');
      return Promise.resolve(
        Response.json(
          first
            ? { rows: [JOB_ROW], nextCursor: cursor }
            : { rows: [{ ...JOB_ROW, id: cursor }], nextCursor: null },
          { status: 200 }
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useJobsQueue({}), { wrapper });
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

  it('rejects a drifting wire shape loudly instead of rendering garbage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [{ id: 1 }] }, { status: 200 })))
    );

    const { result } = renderHook(() => useJobsQueue({}), { wrapper });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
