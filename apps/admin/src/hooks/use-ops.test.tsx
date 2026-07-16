import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { requestUrl } from '@/test-utils/request-url';
import { opsKeys, useOps } from './use-ops.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  ops: [
    {
      name: 'wallet.credit',
      title: 'Credit wallet',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'wallet.clawback',
      fields: ['walletId', 'amountNanoUsd', 'reason'],
      guardrails: { maxAmountNanoUsd: '1000000000000' },
    },
  ],
};

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('opsKeys', () => {
  it('namespaces the ops query key under admin', () => {
    expect(opsKeys.all).toEqual(['admin', 'ops']);
  });
});

describe('useOps', () => {
  it('fetches the op catalog through the typed client', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(Response.json(CATALOG, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useOps(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.ops[0]?.name).toBe('wallet.credit');
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain('/api/admin/ops');
  });

  it('does not fetch when disabled', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useOps({ enabled: false }), { wrapper });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed catalog payload (shared-schema re-validation)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ ops: [{ name: 42 }] }, { status: 200 })))
    );

    const { result } = renderHook(() => useOps(), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });

  it('surfaces an error state on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'UNAVAILABLE' }, { status: 503 })))
    );

    const { result } = renderHook(() => useOps(), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
