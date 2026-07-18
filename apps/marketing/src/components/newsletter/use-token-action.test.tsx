import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTokenAction } from './use-token-action';

function mockFetch(response: {
  ok: boolean;
  status: number;
  body?: unknown;
  rejectJson?: boolean;
}): ReturnType<typeof vi.fn> {
  const json =
    response.rejectJson === true
      ? (): Promise<unknown> => Promise.reject(new Error('not json'))
      : (): Promise<unknown> => Promise.resolve('body' in response ? response.body : { ok: true });
  const function_ = vi.fn(() =>
    Promise.resolve({
      ok: response.ok,
      status: response.status,
      json,
    })
  );
  vi.stubGlobal('fetch', function_);
  return function_;
}

describe('useTokenAction', () => {
  beforeEach(() => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports missing without a request when the URL has no token', () => {
    const fetchMock = mockFetch({ ok: true, status: 200 });
    const { result } = renderHook(() => useTokenAction('/newsletter/confirm'));
    expect(result.current.status).toBe('missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the token as JSON to the given path', async () => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed?token=tok-123');
    const fetchMock = mockFetch({ ok: true, status: 200 });
    renderHook(() => useTokenAction('/newsletter/confirm'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/newsletter/confirm');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ token: 'tok-123' }));
  });

  it('starts pending while the request is in flight', () => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed?token=tok-123');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    const { result } = renderHook(() => useTokenAction('/newsletter/confirm'));
    expect(result.current.status).toBe('pending');
  });

  it('resolves to success on an ok response', async () => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed?token=tok-123');
    mockFetch({ ok: true, status: 200 });
    const { result } = renderHook(() => useTokenAction('/newsletter/confirm'));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.code).toBeNull();
  });

  it('surfaces the API error code on a 400 response', async () => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed?token=tok-bad');
    mockFetch({ ok: false, status: 400, body: { code: 'NEWSLETTER_CONFIRM_INVALID' } });
    const { result } = renderHook(() => useTokenAction('/newsletter/confirm'));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.code).toBe('NEWSLETTER_CONFIRM_INVALID');
  });

  it('treats an empty token value as missing', () => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed?token=');
    const fetchMock = mockFetch({ ok: true, status: 200 });
    const { result } = renderHook(() => useTokenAction('/newsletter/confirm'));
    expect(result.current.status).toBe('missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an object without a code', {}],
    ['a non-string code', { code: 5 }],
    ['a null body', null],
    ['a non-object body', 'nope'],
  ])('reports an error with a null code when the failure body is %s', async (_label, body) => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed?token=tok-bad');
    mockFetch({ ok: false, status: 400, body });
    const { result } = renderHook(() => useTokenAction('/newsletter/confirm'));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.code).toBeNull();
  });

  it('reports an error with a null code when the failure body is not JSON', async () => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed?token=tok-bad');
    mockFetch({ ok: false, status: 502, rejectJson: true });
    const { result } = renderHook(() => useTokenAction('/newsletter/confirm'));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.code).toBeNull();
  });

  it('discards a response that lands after unmount', async () => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed?token=tok-123');
    let resolveFetch: (value: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      )
    );
    const { result, unmount } = renderHook(() => useTokenAction('/newsletter/confirm'));
    unmount();
    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.status).toBe('pending');
  });

  it('discards a stale response from a superseded run', async () => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed?token=tok-123');
    const resolvers: ((value: unknown) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          })
      )
    );
    const { result, rerender } = renderHook(({ path }: { path: string }) => useTokenAction(path), {
      initialProps: { path: '/newsletter/confirm' },
    });
    rerender({ path: '/newsletter/unsubscribe' });
    await waitFor(() => {
      expect(resolvers).toHaveLength(2);
    });
    // Run 1's error lands after run 2 started; it must not touch state.
    await act(async () => {
      resolvers[0]?.({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ code: 'NEWSLETTER_CONFIRM_INVALID' }),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.status).toBe('pending');
    await act(async () => {
      resolvers[1]?.({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.status).toBe('success');
  });

  it('reports an error with a null code when the network fails', async () => {
    globalThis.history.replaceState(null, '', '/newsletter/confirmed?token=tok-123');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down')))
    );
    const { result } = renderHook(() => useTokenAction('/newsletter/confirm'));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.code).toBeNull();
  });
});
