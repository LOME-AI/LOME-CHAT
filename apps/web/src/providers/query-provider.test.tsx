import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';

vi.mock('@/lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public data?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

import { ROUTES } from '@hushbox/shared';
import { ApiError } from '@/lib/api';
import {
  QueryProvider,
  queryClient,
  handleSessionRevocation,
  registerSessionRevocationClearer,
  resetSessionRevocationGuard,
} from './query-provider';
import { shouldRetry, shouldRetryMutation, computeRetryDelay } from '@/lib/retry';

vi.mock('@tanstack/react-query-devtools', () => ({
  ReactQueryDevtools: () => <div data-testid="react-query-devtools" />,
}));

vi.mock('@/lib/env', () => ({
  env: { isLocalDev: true },
}));

function TestQueryConsumer(): React.ReactNode {
  const { isLoading } = useQuery({
    queryKey: ['test'],
    queryFn: () => Promise.resolve('test'),
    enabled: false,
  });
  return <div data-testid="consumer">Loading: {String(isLoading)}</div>;
}

describe('QueryProvider', () => {
  let originalWebdriver: boolean;

  beforeEach(() => {
    originalWebdriver = navigator.webdriver;
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'webdriver', {
      value: originalWebdriver,
      configurable: true,
    });
  });

  it('renders children', () => {
    render(
      <QueryProvider>
        <div data-testid="child">Hello</div>
      </QueryProvider>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('provides QueryClient context to children', () => {
    render(
      <QueryProvider>
        <TestQueryConsumer />
      </QueryProvider>
    );

    // If context wasn't provided, useQuery would throw
    expect(screen.getByTestId('consumer')).toBeInTheDocument();
  });

  it('does not render devtools when navigator.webdriver is true', () => {
    Object.defineProperty(navigator, 'webdriver', {
      value: true,
      configurable: true,
    });

    render(
      <QueryProvider>
        <div>child</div>
      </QueryProvider>
    );

    expect(screen.queryByTestId('react-query-devtools')).not.toBeInTheDocument();
  });

  it('renders devtools in local dev when not automated', () => {
    Object.defineProperty(navigator, 'webdriver', {
      value: false,
      configurable: true,
    });

    render(
      <QueryProvider>
        <div>child</div>
      </QueryProvider>
    );

    expect(screen.getByTestId('react-query-devtools')).toBeInTheDocument();
  });
});

describe('queryClient retry policy', () => {
  it('wires full transient retry for queries and network-only retry for mutations', () => {
    const defaults = queryClient.getDefaultOptions();
    expect(defaults.queries?.retry).toBe(shouldRetry);
    expect(defaults.queries?.retryDelay).toBe(computeRetryDelay);
    expect(defaults.mutations?.retry).toBe(shouldRetryMutation);
    expect(defaults.mutations?.retryDelay).toBe(computeRetryDelay);
  });
});

describe('mid-session 401 revocation', () => {
  let assignSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    resetSessionRevocationGuard();
    // Default: a live session that clears successfully.
    registerSessionRevocationClearer(() => true);
    assignSpy = vi.fn();
    originalLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { pathname: '/chat', assign: assignSpy },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('clears auth and redirects to login exactly once on a mid-session 401', () => {
    const clearer = vi.fn(() => true);
    registerSessionRevocationClearer(clearer);

    handleSessionRevocation(new ApiError('UNAUTHORIZED', 401));

    expect(clearer).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith(ROUTES.LOGIN);
  });

  it('does not redirect again on a second mid-session 401 (no loop)', () => {
    handleSessionRevocation(new ApiError('UNAUTHORIZED', 401));
    handleSessionRevocation(new ApiError('UNAUTHORIZED', 401));
    handleSessionRevocation(new ApiError('UNAUTHORIZED', 401));

    expect(assignSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-401 error', () => {
    const clearer = vi.fn(() => true);
    registerSessionRevocationClearer(clearer);

    handleSessionRevocation(new ApiError('INTERNAL', 500));
    handleSessionRevocation(new TypeError('fetch failed'));

    expect(clearer).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('does nothing on a 401 before any clearer is registered (pre-startup)', () => {
    resetSessionRevocationGuard(); // drops the clearer registered in beforeEach

    handleSessionRevocation(new ApiError('UNAUTHORIZED', 401));

    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('does nothing when no live session exists (expected login-challenge 401)', () => {
    // Clearer returns false ⇒ no session ⇒ this is an expected auth-challenge
    // 401 (OPAQUE login), never a mid-session revocation.
    registerSessionRevocationClearer(() => false);

    handleSessionRevocation(new ApiError('UNAUTHORIZED', 401));

    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('does not redirect when already on the login route', () => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { pathname: ROUTES.LOGIN, assign: assignSpy },
    });
    const clearer = vi.fn(() => true);
    registerSessionRevocationClearer(clearer);

    handleSessionRevocation(new ApiError('UNAUTHORIZED', 401));

    expect(clearer).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('wires the revocation handler into both the query and mutation caches', () => {
    expect(queryClient.getQueryCache().config.onError).toBe(handleSessionRevocation);
    expect(queryClient.getMutationCache().config.onError).toBe(handleSessionRevocation);
  });
});
