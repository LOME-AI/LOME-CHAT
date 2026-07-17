import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { requestUrl } from '@/test-utils/request-url';
import { auditKeys, useAuditSearch } from './use-audit-search.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const AUDIT_ROW = {
  id: '018f6b3a-0000-7000-8000-00000000000c',
  actor: 'ops@hushbox.test',
  action: 'job.discard',
  targetType: 'job',
  targetId: '018f6b3a-0000-7000-8000-00000000000a',
  details: { input: { reason: 'superseded' }, effects: [], inverseInput: null },
  undoes: null,
  undoneBy: null,
  createdAt: '2026-07-14T10:00:00.000Z',
};

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('auditKeys', () => {
  it('keys the search by every filter dimension', () => {
    expect(auditKeys.all).toEqual(['admin', 'audit']);
    expect(auditKeys.search({ actor: 'a', action: 'b' })).toEqual([
      'admin',
      'audit',
      'a',
      'b',
      '',
      '',
      '',
      '',
    ]);
  });
});

describe('useAuditSearch', () => {
  it('fetches one page with only the set filters in the query', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(Response.json({ rows: [AUDIT_ROW], nextCursor: null }, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(
      () =>
        useAuditSearch({
          action: 'job.discard',
          targetType: 'job',
          targetId: '018f6b3a-0000-7000-8000-00000000000a',
          from: '2026-07-01T00:00:00.000Z',
          to: '2026-07-14T00:00:00.000Z',
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const url = requestUrl(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/admin/audit');
    expect(url).toContain('action=job.discard');
    expect(url).toContain('targetType=job');
    expect(url).toContain('targetId=');
    expect(url).toContain('from=');
    expect(url).toContain('to=');
    expect(url).not.toContain('actor=');
  });

  it('pages with the cursor from nextCursor', async () => {
    const cursor = '018f6b3a-0000-7000-8000-00000000000d';
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        Response.json(
          requestUrl(input).includes('cursor=')
            ? { rows: [], nextCursor: null }
            : { rows: [AUDIT_ROW], nextCursor: cursor },
          { status: 200 }
        )
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAuditSearch({}), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.hasNextPage).toBe(true);
    await result.current.fetchNextPage();
    await waitFor(() => {
      expect(result.current.hasNextPage).toBe(false);
    });
    expect(requestUrl(fetchMock.mock.calls[1]![0])).toContain(`cursor=${cursor}`);
  });

  it('rejects a drifting wire shape loudly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [{ id: 1 }] }, { status: 200 })))
    );
    const { result } = renderHook(() => useAuditSearch({}), { wrapper });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
