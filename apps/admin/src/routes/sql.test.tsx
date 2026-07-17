import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { Route } from './sql.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SQL panel route', () => {
  it('renders the SQL panel screen', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    );
    const Component = (Route as { options?: { component?: React.ComponentType } }).options
      ?.component;
    if (Component === undefined) {
      throw new Error('sql route has no component');
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>
    );
    expect(screen.getByRole('heading', { name: 'SQL panel' })).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminSqlEditor)).toBeInTheDocument();
  });
});
