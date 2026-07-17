import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { Route } from './jobs.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Jobs route', () => {
  it('renders the jobs queue screen', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    );
    const Component = (Route as { options?: { component?: React.ComponentType } }).options
      ?.component;
    if (Component === undefined) {
      throw new Error('jobs route has no component');
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpModalProvider>
          <Component />
        </OpModalProvider>
      </QueryClientProvider>
    );
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
