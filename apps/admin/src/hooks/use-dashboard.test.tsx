import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { requestUrl } from '@/test-utils/request-url';
import { dashboardKeys, useDashboard } from './use-dashboard.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const DASHBOARD = {
  jobs: { pending: 2, running: 1, dead: 3, discarded: 0 },
  recentActions: [],
};

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('dashboardKeys', () => {
  it('namespaces the dashboard query key under admin', () => {
    expect(dashboardKeys.all).toEqual(['admin', 'dashboard']);
  });
});

describe('useDashboard', () => {
  it('fetches the dashboard through the typed client', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(Response.json(DASHBOARD, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDashboard(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.jobs.pending).toBe(2);
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain('/api/admin/dashboard');
  });

  it('rejects a drifting wire shape loudly instead of rendering garbage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ jobs: { pending: 2 } }, { status: 200 })))
    );

    const { result } = renderHook(() => useDashboard(), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });

  it('surfaces an error state on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'UNAVAILABLE' }, { status: 503 })))
    );

    const { result } = renderHook(() => useDashboard(), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
