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
    conversations: {
      ':conversationId': { funding: { $get: vi.fn() } },
    },
  },
  fetchJson: vi.fn(),
}));

const { mockLinkGuest } = vi.hoisted(() => ({
  mockLinkGuest: { current: null as string | null },
}));

vi.mock('@/lib/link-guest-auth.js', () => ({
  getLinkGuestAuth: () => mockLinkGuest.current,
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

  it('scopes a payer-specific key under the family prefix', () => {
    expect(billingKeys.spendableFor('conv-1')).toEqual([
      'billing',
      'spendable',
      { conversationId: 'conv-1' },
    ]);
  });

  it('keeps the solo key under the same prefix', () => {
    expect(billingKeys.spendableFor(null)).toEqual([
      'billing',
      'spendable',
      { conversationId: null },
    ]);
  });

  it('starts every scoped key with the family prefix, so one invalidation clears them all', () => {
    // The freshness path invalidates `billingKeys.spendable()` with no argument;
    // TanStack matches by prefix, so a conversation-scoped entry must be a
    // prefix extension of it, never a sibling key.
    const prefix = billingKeys.spendable();
    expect(billingKeys.spendableFor('conv-1').slice(0, prefix.length)).toEqual(prefix);
  });
});

describe('useSpendable', () => {
  beforeEach(() => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-1' } },
    } as unknown as ReturnType<typeof useSession>);
    mockLinkGuest.current = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the served spendable for an authenticated user', async () => {
    const response = {
      spendableNanoUsd: '1500000000',
      heldNanoUsd: '300000000',
      payerTier: 'paid',
      payer: 'self',
    };
    mockedFetchJson.mockResolvedValue(response);

    const { result } = renderHook(() => useSpendable(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.data).toEqual(response);
    });
    expect(mockedClient.billing.spendable.$get).toHaveBeenCalledTimes(1);
  });

  it('asks for no conversation scope outside a conversation', async () => {
    mockedFetchJson.mockResolvedValue({
      spendableNanoUsd: '1',
      heldNanoUsd: '0',
      payerTier: 'paid',
      payer: 'self',
    });

    const { result } = renderHook(() => useSpendable(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(mockedClient.billing.spendable.$get).toHaveBeenCalledWith({ query: {} });
  });

  it('asks for the payer of the conversation it is given', async () => {
    mockedFetchJson.mockResolvedValue({
      spendableNanoUsd: '800000000',
      heldNanoUsd: '0',
      payerTier: 'paid',
      payer: 'owner',
    });

    const { result } = renderHook(() => useSpendable('conv-9'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.data?.payer).toBe('owner');
    });
    expect(mockedClient.billing.spendable.$get).toHaveBeenCalledWith({
      query: { conversationId: 'conv-9' },
    });
  });

  it('refetches a conversation-scoped read when the whole family is invalidated', async () => {
    // The freshness path (WS run frames, socket-ready catch-up, focus)
    // invalidates the family prefix with no conversation argument. A
    // payer-scoped key must still be reached by it, or a released hold would
    // stay invisible to a group composer until its stale time expired.
    mockedFetchJson.mockResolvedValue({
      spendableNanoUsd: '800000000',
      heldNanoUsd: '0',
      payerTier: 'paid',
      payer: 'owner',
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }
    const { result } = renderHook(() => useSpendable('conv-9'), { wrapper: Wrapper });
    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    await queryClient.invalidateQueries({ queryKey: billingKeys.spendable() });

    await waitFor(() => {
      expect(mockedClient.billing.spendable.$get).toHaveBeenCalledTimes(2);
    });
  });

  it('caches the solo and conversation reads separately — they are different payers', async () => {
    mockedFetchJson.mockResolvedValue({
      spendableNanoUsd: '1',
      heldNanoUsd: '0',
      payerTier: 'paid',
      payer: 'self',
    });
    const wrapper = createWrapper();

    const solo = renderHook(() => useSpendable(), { wrapper });
    await waitFor(() => {
      expect(solo.result.current.data).toBeDefined();
    });
    const scoped = renderHook(() => useSpendable('conv-9'), { wrapper });
    await waitFor(() => {
      expect(scoped.result.current.data).toBeDefined();
    });

    expect(mockedClient.billing.spendable.$get).toHaveBeenCalledTimes(2);
  });

  it('does not fetch for a trial user — no funding door exists for them', () => {
    mockedUseSession.mockReturnValue({ data: null } as unknown as ReturnType<typeof useSession>);

    const { result } = renderHook(() => useSpendable(), { wrapper: createWrapper() });

    expect(result.current.data).toBeUndefined();
    expect(mockedFetchJson).not.toHaveBeenCalled();
  });

  describe("the link guest's door", () => {
    beforeEach(() => {
      mockedUseSession.mockReturnValue({ data: null } as unknown as ReturnType<typeof useSession>);
      mockLinkGuest.current = 'link-public-key';
    });

    it("reads the payer's snapshot from the conversation, never the billing-token route", async () => {
      const response = {
        spendableNanoUsd: '900000000',
        heldNanoUsd: '0',
        payerTier: 'paid',
        payer: 'owner',
      };
      mockedFetchJson.mockResolvedValue(response);

      const { result } = renderHook(() => useSpendable('conv-9'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.data).toEqual(response);
      });
      expect(mockedClient.conversations[':conversationId'].funding.$get).toHaveBeenCalledWith({
        param: { conversationId: 'conv-9' },
      });
      expect(mockedClient.billing.spendable.$get).not.toHaveBeenCalled();
    });

    it('does not fetch outside a conversation — a guest has no payer without one', () => {
      const { result } = renderHook(() => useSpendable(), { wrapper: createWrapper() });

      expect(result.current.data).toBeUndefined();
      expect(mockedFetchJson).not.toHaveBeenCalled();
    });
  });
});
