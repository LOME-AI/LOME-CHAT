import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

import { meQueryOptions } from './auth-queries';
import { urlFromFetchInput } from '@/test-utils/fetch-mock';

describe('meQueryOptions', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keys the query under auth/me', () => {
    expect(meQueryOptions().queryKey).toEqual(['auth', 'me']);
  });

  it('fetches the current user from /auth/me via the typed client', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({ user: { id: 'u1' } }),
    } as unknown as Response);

    const data = await meQueryOptions().queryFn();

    expect(data).toEqual({ user: { id: 'u1' } });
    const meCall = mockFetch.mock.calls.find(([input]) =>
      urlFromFetchInput(input).includes('/auth/me')
    );
    expect(meCall).toBeDefined();
  });
});
