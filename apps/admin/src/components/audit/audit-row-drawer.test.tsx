import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { AuditRowDrawer } from './audit-row-drawer.js';
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
  ],
};

const USER_ID = '018f6b3a-0000-7000-8000-000000000002';

const ROW: AdminAuditRowWire = {
  id: '018f6b3a-0000-7000-8000-000000000001',
  actor: 'founder@hushbox.test',
  action: 'user.lock',
  targetType: 'user',
  targetId: USER_ID,
  details: {
    input: { userId: USER_ID, lockReason: 'chargeback', reason: 'dispute received' },
    effects: [{ label: 'user.lockedAt', before: null, after: '2026-07-15T09:30:00.000Z' }],
    inverseInput: { userId: USER_ID, reason: 'undo lock' },
  },
  undoes: null,
  undoneBy: null,
  createdAt: '2026-07-15T09:30:00.000Z',
};

function stubCatalogFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(CATALOG)))
  );
}

interface Handlers {
  onClose?: () => void;
  onStep?: (direction: 1 | -1) => void;
  onJump?: (auditId: string) => void;
}

function renderDrawer(row: AdminAuditRowWire, handlers: Handlers = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <AuditRowDrawer
          row={row}
          onClose={handlers.onClose ?? vi.fn()}
          onStep={handlers.onStep ?? vi.fn()}
          onJump={handlers.onJump ?? vi.fn()}
        />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('AuditRowDrawer', () => {
  it('renders actor, target, reason and the changed-fields diff', () => {
    stubCatalogFetch();
    renderDrawer(ROW);
    const drawer = screen.getByTestId(TEST_IDS.adminAuditDrawer);
    expect(within(drawer).getByText('founder@hushbox.test')).toBeInTheDocument();
    expect(within(drawer).getByText(USER_ID)).toBeInTheDocument();
    expect(within(drawer).getByText('dispute received')).toBeInTheDocument();
    const diff = within(drawer).getByTestId(TEST_IDS.adminOpDiff);
    expect(within(diff).getByText('user.lockedAt')).toBeInTheDocument();
  });

  it('falls back gracefully for a row without structured effects', () => {
    stubCatalogFetch();
    renderDrawer({ ...ROW, action: 'read.sqlPanel', details: { query: 'SELECT 1' } });
    expect(screen.getByText(/no structured effects/i)).toBeInTheDocument();
  });

  it('reveals the raw JSON behind a toggle', async () => {
    stubCatalogFetch();
    renderDrawer(ROW);
    expect(screen.queryByText(/"inverseInput"/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminAuditDrawerRaw));
    expect(screen.getByText(/"inverseInput"/)).toBeInTheDocument();
  });

  it('offers Undo on a reversible row through the OpModal', async () => {
    stubCatalogFetch();
    renderDrawer(ROW);
    await userEvent.click(await screen.findByTestId(TEST_IDS.adminAuditUndo));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Unlock account')).toBeInTheDocument();
  });

  it('threads the undo pair: jump buttons for undoes and undoneBy', async () => {
    stubCatalogFetch();
    const onJump = vi.fn();
    const undoneBy = '018f6b3a-0000-7000-8000-00000000bbbb';
    renderDrawer({ ...ROW, undoneBy }, { onJump });
    await userEvent.click(screen.getByRole('button', { name: /undone by/i }));
    expect(onJump).toHaveBeenCalledWith(undoneBy);
  });

  it('steps between rows with the arrow keys and closes on Escape', async () => {
    stubCatalogFetch();
    const onStep = vi.fn();
    const onClose = vi.fn();
    renderDrawer(ROW, { onStep, onClose });
    await userEvent.keyboard('{ArrowDown}');
    expect(onStep).toHaveBeenCalledWith(1);
    await userEvent.keyboard('{ArrowUp}');
    expect(onStep).toHaveBeenCalledWith(-1);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('ignores arrow keys while typing in a form control', async () => {
    stubCatalogFetch();
    const onStep = vi.fn();
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <OpModalProvider>
          <input aria-label="outside" />
          <AuditRowDrawer row={ROW} onClose={vi.fn()} onStep={onStep} onJump={vi.fn()} />
        </OpModalProvider>
      </QueryClientProvider>
    );
    await userEvent.click(screen.getByLabelText('outside'));
    await userEvent.keyboard('{ArrowDown}');
    expect(onStep).not.toHaveBeenCalled();
  });
});

describe('AuditRowDrawer edge shapes', () => {
  it('falls back when the effects array itself is malformed', () => {
    stubCatalogFetch();
    renderDrawer({
      ...ROW,
      details: { input: {}, effects: [42], inverseInput: null },
    });
    expect(screen.getByText(/no structured effects/i)).toBeInTheDocument();
  });

  it('renders a target-less row and a reason-less row honestly', () => {
    stubCatalogFetch();
    renderDrawer({
      ...ROW,
      targetType: null,
      targetId: null,
      details: { input: {}, effects: [], inverseInput: null },
    });
    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByText('none recorded')).toBeInTheDocument();
  });

  it('jumps to the undone target from the Undoes link', async () => {
    stubCatalogFetch();
    const onJump = vi.fn();
    const undoes = '018f6b3a-0000-7000-8000-00000000aaaa';
    renderDrawer({ ...ROW, undoes }, { onJump });
    await userEvent.click(screen.getByRole('button', { name: /^undoes/i }));
    expect(onJump).toHaveBeenCalledWith(undoes);
  });
});
