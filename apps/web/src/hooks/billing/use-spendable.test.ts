import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useSpendable } from '@/hooks/billing/use-spendable.js';
import { billingKeys } from '@/hooks/billing/billing.js';

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/lib/api-client.js', () => ({
  client: {
    billing: {
      spendable: { $get: vi.fn() },
    },
  },
  fetchJson: vi.fn(),
}));

import { useSession } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client.js';

const mockedUseSession = vi.mocked(useSession);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client, true);

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('billingKeys.spendable', () => {
  it('nests under the billing key family for family-wide invalidation', () => {
    expect(billingKeys.spendable()).toEqual(['billing', 'spendable']);
  });
});

describe('useSpendable', () => {
  beforeEach(() => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-1' } },
    } as unknown as ReturnType<typeof useSession>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the served spendable for an authenticated user', async () => {
    const response = { spendableNanoUsd: '1500000000', heldNanoUsd: '300000000' };
    mockedFetchJson.mockResolvedValue(response);

    const { result } = renderHook(() => useSpendable(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.data).toEqual(response);
    });
    expect(mockedClient.billing.spendable.$get).toHaveBeenCalledTimes(1);
  });

  it('does not fetch for an unauthenticated (trial/guest) user — no endpoint exists for them', () => {
    mockedUseSession.mockReturnValue({ data: null } as unknown as ReturnType<typeof useSession>);

    const { result } = renderHook(() => useSpendable(), { wrapper: createWrapper() });

    expect(result.current.data).toBeUndefined();
    expect(mockedFetchJson).not.toHaveBeenCalled();
  });
});
