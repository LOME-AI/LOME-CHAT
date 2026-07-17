import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { requestUrl } from '@/test-utils/request-url';
import { ApiError } from '@/lib/api-client';
import { useSqlPanel } from './use-sql-panel.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useSqlPanel', () => {
  it('runs the query through the typed client and parses the result page', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({ rows: [{ id: 'a' }], rowCount: 1, truncated: false }, { status: 200 })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSqlPanel(), { wrapper });
    result.current.mutate('SELECT id FROM jobs');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.rowCount).toBe(1);
    const url = requestUrl(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/admin/sql');
    expect(url).toContain('query=SELECT+id+FROM+jobs');
  });

  it('surfaces the server error body through ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'VALIDATION' }, { status: 400 })))
    );
    const { result } = renderHook(() => useSqlPanel(), { wrapper });
    result.current.mutate('DROP TABLE jobs');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).body).toEqual({ code: 'VALIDATION' });
  });

  it('rejects a drifting result shape loudly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [] }, { status: 200 })))
    );
    const { result } = renderHook(() => useSqlPanel(), { wrapper });
    result.current.mutate('SELECT 1');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
