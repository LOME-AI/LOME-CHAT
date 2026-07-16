import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { AuditActionsTable } from './audit-actions-table.js';
import type { AdminAuditRowWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  ops: [
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

const LOCK_ROW: AdminAuditRowWire = {
  id: '018f6b3a-0000-7000-8000-000000000001',
  actor: 'founder@hushbox.ai',
  action: 'user.lock',
  targetType: 'user',
  targetId: USER_ID,
  details: {
    input: { userId: USER_ID, lockReason: 'chargeback', reason: 'dispute received' },
    effects: [{ label: 'user.lockedAt' }],
    inverseInput: { userId: USER_ID, reason: 'undo lock' },
  },
  undoes: null,
  undoneBy: null,
  createdAt: '2026-07-15T09:30:00.000Z',
};

function renderTable(rows: readonly AdminAuditRowWire[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <AuditActionsTable rows={rows} />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

function stubCatalogFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(CATALOG)))
  );
}

describe('AuditActionsTable', () => {
  it('renders time, actor, action, target, and reason for each row', () => {
    stubCatalogFetch();
    renderTable([LOCK_ROW]);

    const row = screen.getByText('user.lock').closest('tr');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('2026-07-15 09:30');
    expect(row).toHaveTextContent('founder@hushbox.ai');
    expect(row).toHaveTextContent(`user:${USER_ID}`);
    expect(row).toHaveTextContent('dispute received');
  });

  it('shows an empty state without rows', () => {
    stubCatalogFetch();
    renderTable([]);

    expect(screen.getByText(/no admin actions/i)).toBeInTheDocument();
  });

  it('offers Undo on a reversible executed row and opens the inverse op prefilled', async () => {
    const user = userEvent.setup();
    stubCatalogFetch();
    renderTable([LOCK_ROW]);

    const undo = await screen.findByTestId(TEST_IDS.adminAuditUndo);
    await user.click(undo);

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Unlock account');
    expect(within(modal).getByLabelText('userId')).toHaveValue(USER_ID);
    expect(within(modal).getByLabelText('reason')).toHaveValue('undo lock');
  });

  it('offers no Undo when the op has no registered inverse', async () => {
    stubCatalogFetch();
    renderTable([
      {
        ...LOCK_ROW,
        action: 'sessions.revokeAll',
        details: { input: { userId: USER_ID, reason: 'r' }, effects: [], inverseInput: null },
      },
    ]);

    await screen.findByText('sessions.revokeAll');
    expect(screen.queryByTestId(TEST_IDS.adminAuditUndo)).not.toBeInTheDocument();
  });

  it('offers no Undo on a read-audit row (details are not an executed effect)', async () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, action: 'read.customer360', details: { query: {} } }]);

    await screen.findByText('read.customer360');
    expect(screen.queryByTestId(TEST_IDS.adminAuditUndo)).not.toBeInTheDocument();
  });

  it('renders an empty target cell and reason for a row with no target or details', () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, targetType: null, targetId: null, details: null }]);

    const row = screen.getByText('user.lock').closest('tr');
    expect(row).not.toHaveTextContent('user:');
  });

  it('renders the bare target type and no reason when targetId and reason are absent', () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, targetId: null, details: { input: { reason: 42 }, effects: [] } }]);

    const row = screen.getByText('user.lock').closest('tr');
    expect(row).toHaveTextContent('user:');
    expect(row).not.toHaveTextContent('dispute received');
  });

  it('offers no Undo when the executed row recorded no inverse input', async () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, details: { input: {}, effects: [], inverseInput: null } }]);

    await screen.findByText('user.lock');
    expect(screen.queryByTestId(TEST_IDS.adminAuditUndo)).not.toBeInTheDocument();
  });

  it('marks an already-undone row instead of offering Undo again', async () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, undoneBy: '018f6b3a-0000-7000-8000-00000000000f' }]);

    await screen.findByText('user.lock');
    expect(screen.queryByTestId(TEST_IDS.adminAuditUndo)).not.toBeInTheDocument();
    expect(screen.getByText(/undone/i)).toBeInTheDocument();
  });
});
