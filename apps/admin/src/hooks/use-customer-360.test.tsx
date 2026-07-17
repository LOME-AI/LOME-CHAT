import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { requestUrl } from '@/test-utils/request-url';
import {
  customer360Keys,
  customer360QueryFor,
  isSearchableUserQuery,
  useCustomer360,
} from './use-customer-360.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER_ID = '018f6b3a-0000-7000-8000-000000000002';

const VIEW = {
  user: {
    id: USER_ID,
    email: 'user@example.com',
    username: 'user',
    emailVerified: true,
    totpEnabled: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    lockedAt: null,
    lockReason: null,
    hasAcknowledgedPhrase: true,
  },
  panels: {
    money: { ok: false, error: 'unavailable' },
    usage: { ok: true, data: { models: [] } },
    conversations: { ok: true, data: { owned: 1, activeMemberships: 2 } },
    devices: { ok: true, data: { count: 0, tokens: [] } },
    jobs: { ok: true, data: { jobs: [] } },
    adminHistory: { ok: true, data: { actions: [] } },
  },
};

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('customer360QueryFor', () => {
  it('treats a uuid as a userId lookup', () => {
    expect(customer360QueryFor(USER_ID)).toEqual({ userId: USER_ID });
  });

  it('treats anything else as an email lookup', () => {
    expect(customer360QueryFor('user@example.com')).toEqual({ email: 'user@example.com' });
  });

  it('trims whitespace before classifying', () => {
    expect(customer360QueryFor(`  ${USER_ID} `)).toEqual({ userId: USER_ID });
  });
});

describe('isSearchableUserQuery', () => {
  it('accepts a uuid', () => {
    expect(isSearchableUserQuery(USER_ID)).toBe(true);
  });

  it('accepts an email-shaped term', () => {
    expect(isSearchableUserQuery('user@example.com')).toBe(true);
  });

  it('rejects a partial string that is neither uuid- nor email-shaped', () => {
    expect(isSearchableUserQuery('alice')).toBe(false);
    expect(isSearchableUserQuery('alice@')).toBe(false);
    expect(isSearchableUserQuery('@example.com')).toBe(false);
    expect(isSearchableUserQuery('018f6b3a')).toBe(false);
  });

  it('trims whitespace before classifying', () => {
    expect(isSearchableUserQuery('  user@example.com ')).toBe(true);
  });
});

describe('customer360Keys', () => {
  it('namespaces per-query keys under the admin customer-360 root', () => {
    expect(customer360Keys.byQuery('a@b.c')).toEqual(['admin', 'customer-360', 'a@b.c']);
  });
});

describe('useCustomer360', () => {
  it('fetches the overview by email through the typed client', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(Response.json(VIEW, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCustomer360('user@example.com'), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.user.email).toBe('user@example.com');
    const url = requestUrl(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/admin/users/overview');
    expect(url).toContain('email=user%40example.com');
  });

  it('fetches by userId when the query is a uuid', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(Response.json(VIEW, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCustomer360(USER_ID), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(`userId=${USER_ID}`);
  });

  it('stays idle without a query string', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    let q: string | undefined;
    const { result } = renderHook(() => useCustomer360(q), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays idle for a term that is neither uuid- nor email-shaped', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCustomer360('alice'), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a drifting wire shape loudly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ user: {} }, { status: 200 })))
    );

    const { result } = renderHook(() => useCustomer360('user@example.com'), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });

  it('surfaces the ApiError for a 404 miss', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'NOT_FOUND' }, { status: 404 })))
    );

    const { result } = renderHook(() => useCustomer360('missing@example.com'), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
