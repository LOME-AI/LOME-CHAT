import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { Route } from './ops.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  ops: [
    {
      name: 'wallet.credit',
      title: 'Credit wallet',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'wallet.clawback',
      fields: ['walletId', 'amountNanoUsd', 'reason'],
      guardrails: { maxAmountNanoUsd: '1000000000000', rateLimitKey: 'wallet-credit' },
    },
    {
      name: 'sessions.revokeAll',
      title: 'Revoke all sessions',
      kind: 'mutation',
      effectClass: 'ephemeral',
      inverse: null,
      fields: ['userId', 'reason'],
    },
  ],
};

function renderScreen(): void {
  const Component = (Route as { options?: { component?: React.ComponentType } }).options?.component;
  if (Component === undefined) {
    throw new Error('ops route has no component');
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

describe('Ops catalog screen', () => {
  it('renders one table row per registered op with its contract facts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(CATALOG)))
    );
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminOpsTable);
    const credit = within(table).getByText('wallet.credit').closest('tr');
    expect(credit).not.toBeNull();
    expect(credit).toHaveTextContent('Credit wallet');
    expect(credit).toHaveTextContent('mutation');
    expect(credit).toHaveTextContent('durable');
    expect(credit).toHaveTextContent('wallet.clawback');
    expect(credit).toHaveTextContent('maxAmount $1,000.00');
    // Non-money guardrails render raw.
    expect(credit).toHaveTextContent('rateLimitKey wallet-credit');

    const revoke = within(table).getByText('sessions.revokeAll').closest('tr');
    expect(revoke).toHaveTextContent('ephemeral');
    expect(revoke).toHaveTextContent('none');
  });

  it('opens the OpModal from a row Run action', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(CATALOG)))
    );
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminOpsTable);
    const row = within(table).getByText('wallet.credit').closest('tr');
    await user.click(within(row as HTMLElement).getByTestId(TEST_IDS.adminOpsRun));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Credit wallet' })).toBeInTheDocument();
  });

  it('shows a loading state then an error state on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'UNAVAILABLE' }, { status: 503 })))
    );
    renderScreen();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Failed to load the op catalog.')).toBeInTheDocument();
    });
  });
});
