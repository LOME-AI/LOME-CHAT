import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { Route } from './feedback.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface FeedbackSearch {
  readonly status?: string | undefined;
  readonly selected?: string | undefined;
}

type ValidateSearch = (search: Record<string, unknown>) => FeedbackSearch;

function validateSearch(search: Record<string, unknown>): FeedbackSearch {
  return (
    Route as unknown as { options: { validateSearch: ValidateSearch } }
  ).options.validateSearch(search);
}

function renderScreen(search: FeedbackSearch): { navigate: ReturnType<typeof vi.fn> } {
  const navigate = vi.fn();
  vi.spyOn(Route, 'useSearch').mockReturnValue(search);
  vi.spyOn(Route, 'useNavigate').mockReturnValue(navigate);
  const Component = (Route as { options?: { component?: React.ComponentType } }).options?.component;
  if (Component === undefined) {
    throw new Error('feedback route has no component');
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

describe('Feedback route', () => {
  it('keeps only a known status and a non-empty selection from the URL', () => {
    expect(validateSearch({ status: 'triaged', selected: 'abc' })).toEqual({
      status: 'triaged',
      selected: 'abc',
    });
    expect(validateSearch({ status: 'bogus', selected: '' })).toEqual({});
    expect(validateSearch({})).toEqual({});
  });

  it('renders the inbox screen with the URL status filter applied', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [], nextCursor: null })))
    );
    renderScreen({ status: 'triaged' });
    expect(screen.getByRole('heading', { name: 'Feedback' })).toBeInTheDocument();
    const tabs = screen.getByTestId(TEST_IDS.adminFeedbackTabs);
    expect(within(tabs).getByRole('button', { name: /triaged/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('round-trips a status change through router navigation, clearing the selection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [], nextCursor: null })))
    );
    const { navigate } = renderScreen({ selected: 'old-id' });
    const tabs = screen.getByTestId(TEST_IDS.adminFeedbackTabs);
    await userEvent.click(within(tabs).getByRole('button', { name: /spam/i }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ search: expect.any(Function) });
    });
    const searchFunction = navigate.mock.calls[0]![0].search as (
      previous: FeedbackSearch
    ) => FeedbackSearch;
    expect(searchFunction({ status: 'new', selected: 'old-id' })).toEqual({
      status: 'spam',
      selected: undefined,
    });
  });

  it('writes the expanded row id into the URL when a row is opened', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            rows: [
              {
                id: '018f6b3a-0000-7000-8000-00000000000a',
                kind: 'bug',
                status: 'new',
                bodyPreview: 'freezes',
                createdAt: '2026-07-14T09:00:00.000Z',
                userId: '018f6b3a-0000-7000-8000-000000000001',
              },
            ],
            nextCursor: null,
          })
        )
      )
    );
    const { navigate } = renderScreen({});
    await userEvent.click(await screen.findByTestId(TEST_IDS.adminFeedbackExpand));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ search: expect.any(Function) });
    });
    const searchFunction = navigate.mock.calls[0]![0].search as (
      previous: FeedbackSearch
    ) => FeedbackSearch;
    expect(searchFunction({})).toEqual({ selected: '018f6b3a-0000-7000-8000-00000000000a' });
  });
});
