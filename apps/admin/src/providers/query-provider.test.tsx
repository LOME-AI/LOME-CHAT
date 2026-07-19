import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiError, AccessExpiredError } from '@/lib/api-client';
import {
  QueryProvider,
  queryClient,
  retryUnlessClientError,
  reloadForReauth,
  reloadOnAccessExpiry,
} from './query-provider.js';

describe('QueryProvider', () => {
  it('renders its children', () => {
    render(
      <QueryProvider>
        <div>child content</div>
      </QueryProvider>
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('never refetches on window focus (ops tool, not a live feed)', () => {
    expect(queryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });

  it('installs the retry policy as the query default', () => {
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(retryUnlessClientError);
  });
});

describe('retryUnlessClientError', () => {
  it('never retries a definitive 4xx ApiError', () => {
    expect(retryUnlessClientError(0, new ApiError('NOT_FOUND', 404))).toBe(false);
    expect(retryUnlessClientError(0, new ApiError('VALIDATION', 400))).toBe(false);
    expect(retryUnlessClientError(0, new ApiError('RATE_LIMITED', 429))).toBe(false);
  });

  it('retries a 5xx ApiError up to three times', () => {
    expect(retryUnlessClientError(0, new ApiError('INTERNAL', 500))).toBe(true);
    expect(retryUnlessClientError(2, new ApiError('INTERNAL', 503))).toBe(true);
    expect(retryUnlessClientError(3, new ApiError('INTERNAL', 500))).toBe(false);
  });

  it('retries a transport failure up to three times', () => {
    expect(retryUnlessClientError(0, new TypeError('fetch failed'))).toBe(true);
    expect(retryUnlessClientError(3, new TypeError('fetch failed'))).toBe(false);
  });

  it('never retries an Access expiry (the login page is not a transient failure)', () => {
    expect(retryUnlessClientError(0, new AccessExpiredError())).toBe(false);
  });
});

describe('Access-expiry re-auth', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    sessionStorage.clear();
    reloadSpy = vi.fn();
    originalLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { reload: reloadSpy },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    vi.useRealTimers();
  });

  it('reloadForReauth navigates so Access re-runs its challenge', () => {
    reloadForReauth();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of expiries into a single reload', () => {
    reloadForReauth();
    reloadForReauth();
    reloadForReauth();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reload again inside the loop-guard window after a prior reload', () => {
    // A reload timestamp already present (as if written just before a reload)
    // must suppress a fresh reload — a challenge that did not clear the cookie
    // cannot spin into a loop.
    sessionStorage.setItem('hushbox.admin.reauthReloadAt', String(Date.now()));
    reloadForReauth();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('reloads again once the loop-guard window has elapsed', () => {
    vi.useFakeTimers();
    reloadForReauth();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11_000);
    reloadForReauth();
    expect(reloadSpy).toHaveBeenCalledTimes(2);
  });

  it('reloadOnAccessExpiry reloads on an AccessExpiredError', () => {
    reloadOnAccessExpiry(new AccessExpiredError());
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('reloadOnAccessExpiry does not reload on a normal ApiError', () => {
    reloadOnAccessExpiry(new ApiError('FORBIDDEN', 403));
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('wires the expiry handler into both the query and mutation caches', () => {
    expect(queryClient.getQueryCache().config.onError).toBe(reloadOnAccessExpiry);
    expect(queryClient.getMutationCache().config.onError).toBe(reloadOnAccessExpiry);
  });
});
