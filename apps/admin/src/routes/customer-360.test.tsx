import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { Route } from './customer-360.js';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderScreen(search: { q?: string }): void {
  vi.spyOn(Route, 'useSearch').mockReturnValue(search);
  const Component = (Route as { options?: { component?: React.ComponentType } }).options?.component;
  if (Component === undefined) {
    throw new Error('customer-360 route has no component');
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <Component />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('Customer 360 route', () => {
  it('accepts a string q search param from the palette go-to-user action', () => {
    const validateSearch = (
      Route as unknown as {
        options: { validateSearch: (search: Record<string, unknown>) => { q?: string } };
      }
    ).options.validateSearch;
    expect(validateSearch({ q: 'user@example.com' })).toEqual({ q: 'user@example.com' });
    expect(validateSearch({ q: 42 })).toEqual({});
    expect(validateSearch({})).toEqual({});
  });

  it('renders the screen empty state without a q param', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    );
    renderScreen({});

    expect(screen.getByTestId(TEST_IDS.adminC360Empty)).toBeInTheDocument();
  });

  it('passes the q param through to the screen query', () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    renderScreen({ q: 'user@example.com' });

    expect(screen.getByTestId(TEST_IDS.adminC360Panels)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });
});
