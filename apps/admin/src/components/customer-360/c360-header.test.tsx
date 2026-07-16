import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { C360Header } from './c360-header.js';
import type { Customer360View } from '@hushbox/shared';

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
    },
    {
      name: 'user.lock',
      title: 'Lock account',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'user.unlock',
      fields: ['userId', 'lockReason', 'reason'],
    },
    {
      name: 'user.unlock',
      title: 'Unlock account',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'user.lock',
      fields: ['userId', 'reason'],
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

const USER_ID = '018f6b3a-0000-7000-8000-000000000002';

const USER: Customer360View['user'] = {
  id: USER_ID,
  email: 'locked@example.com',
  username: 'locked-user',
  emailVerified: true,
  totpEnabled: true,
  lockedAt: '2026-07-10T00:00:00.000Z',
  hasAcknowledgedPhrase: true,
};

const MONEY: Customer360View['panels']['money'] = {
  ok: true,
  data: {
    balance: {
      purchasedNanoUsd: '-2500000000',
      freeNanoUsd: '0',
      allowance: {
        day: '2026-07-15',
        limitNanoUsd: '100000000',
        spentNanoUsd: '0',
        remainingNanoUsd: '100000000',
      },
    },
    recentLedger: [],
  },
};

function renderHeader(
  user: Customer360View['user'] = USER,
  money: Customer360View['panels']['money'] = MONEY
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(CATALOG)))
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <C360Header user={user} money={money} />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('C360Header', () => {
  it('shows the email, copyable user id, and username', () => {
    renderHeader();

    const header = screen.getByTestId(TEST_IDS.adminC360Header);
    expect(header).toHaveTextContent('locked@example.com');
    expect(header).toHaveTextContent(USER_ID);
    expect(header).toHaveTextContent('locked-user');
    expect(within(header).getByRole('button', { name: 'Copy user id' })).toBeInTheDocument();
  });

  it('shows the lock chip with the lock date and the negative balance', () => {
    renderHeader();

    const header = screen.getByTestId(TEST_IDS.adminC360Header);
    expect(header).toHaveTextContent('Locked since 2026-07-10');
    expect(header).toHaveTextContent('-$2.50');
  });

  it('shows Active for an unlocked user and an unverified-email chip', () => {
    renderHeader({ ...USER, lockedAt: null, emailVerified: false });

    const header = screen.getByTestId(TEST_IDS.adminC360Header);
    expect(header).toHaveTextContent('Active');
    expect(header).toHaveTextContent('Email unverified');
  });

  it('omits the balance chip when the money panel failed', () => {
    renderHeader(USER, { ok: false, error: 'unavailable' });

    expect(screen.getByTestId(TEST_IDS.adminC360Header)).not.toHaveTextContent('$');
  });

  it('opens Unlock prefilled with the user id for a locked user', async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole('button', { name: 'Unlock account' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Unlock account');
    expect(within(modal).getByLabelText('userId')).toHaveValue(USER_ID);
  });

  it('offers Lock instead of Unlock for an active user', async () => {
    const user = userEvent.setup();
    renderHeader({ ...USER, lockedAt: null });

    expect(screen.queryByRole('button', { name: 'Unlock account' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lock account' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByLabelText('userId')).toHaveValue(USER_ID);
  });

  it('opens Revoke sessions prefilled with the user id', async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole('button', { name: 'Revoke all sessions' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByLabelText('userId')).toHaveValue(USER_ID);
  });

  it('opens Credit wallet (no prefill: the view carries no wallet id)', async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole('button', { name: 'Credit wallet' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Credit wallet');
    expect(within(modal).getByLabelText('walletId')).toHaveValue('');
  });
});
