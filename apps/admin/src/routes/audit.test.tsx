import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { Route } from './audit.js';
import type { AuditFilters } from '@/hooks/use-audit-search';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type ValidateSearch = (search: Record<string, unknown>) => AuditFilters;

function validateSearch(search: Record<string, unknown>): AuditFilters {
  return (
    Route as unknown as { options: { validateSearch: ValidateSearch } }
  ).options.validateSearch(search);
}

function renderScreen(search: AuditFilters): { navigate: ReturnType<typeof vi.fn> } {
  const navigate = vi.fn();
  vi.spyOn(Route, 'useSearch').mockReturnValue(search);
  vi.spyOn(Route, 'useNavigate').mockReturnValue(navigate);
  const Component = (Route as { options?: { component?: React.ComponentType } }).options?.component;
  if (Component === undefined) {
    throw new Error('audit route has no component');
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <Component />
      </OpModalProvider>
    </QueryClientProvider>
  );
  return { navigate };
}

describe('Audit route', () => {
  it('keeps only known, non-empty string filters from the URL', () => {
    expect(validateSearch({ actor: 'a', action: '', from: 42, bogus: 'x', targetId: 't' })).toEqual(
      { actor: 'a', targetId: 't' }
    );
    expect(validateSearch({})).toEqual({});
  });

  it('normalizes URL-supplied datetime filters to full ISO', () => {
    expect(validateSearch({ from: '2026-07-01', to: '2026-07-15T10:30:00Z' })).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-15T10:30:00.000Z',
    });
  });

  it('drops an unparseable URL datetime instead of sending a guaranteed 400', () => {
    expect(validateSearch({ from: 'garbage', to: '2026-07-15T00:00:00Z', actor: 'a' })).toEqual({
      to: '2026-07-15T00:00:00.000Z',
      actor: 'a',
    });
  });

  it('renders the trail screen with URL filters applied as pills', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [], nextCursor: null })))
    );
    renderScreen({ action: 'user.lock' });
    expect(screen.getByRole('heading', { name: 'Audit trail' })).toBeInTheDocument();
    expect(await screen.findByTestId(TEST_IDS.adminAuditFilterPill)).toHaveTextContent('user.lock');
  });

  it('round-trips filter changes through router navigation (URL ownership)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [], nextCursor: null })))
    );
    const { navigate } = renderScreen({});
    await userEvent.type(screen.getByLabelText('Action'), 'job.discard');
    await userEvent.click(screen.getByTestId(TEST_IDS.adminAuditApplyFilters));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ search: { action: 'job.discard' } });
    });
  });
});
