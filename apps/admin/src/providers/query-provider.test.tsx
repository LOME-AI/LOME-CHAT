import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiError } from '@/lib/api-client';
import { QueryProvider, queryClient, retryUnlessClientError } from './query-provider.js';

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
});
