import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { AuditTrailScreen, stepAuditSelection } from './audit-trail-screen.js';
import type { AuditFilters } from '@/hooks/use-audit-search';
import type { AdminAuditRowWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = { ops: [] };

function auditRow(overrides: Partial<AdminAuditRowWire>): AdminAuditRowWire {
  return {
    id: '018f6b3a-0000-7000-8000-000000000001',
    actor: 'founder@hushbox.test',
    action: 'user.lock',
    targetType: 'user',
    targetId: '018f6b3a-0000-7000-8000-000000000002',
    details: {
      input: { reason: 'dispute received' },
      effects: [],
      inverseInput: null,
    },
    undoes: null,
    undoneBy: null,
    createdAt: '2026-07-15T09:30:00.000Z',
    ...overrides,
  };
}

const ROW_A = auditRow({});
const ROW_B = auditRow({
  id: '018f6b3a-0000-7000-8000-000000000003',
  action: 'wallet.credit',
  createdAt: '2026-07-15T09:00:00.000Z',
});

type JsonBody = Record<string, unknown>;

function stubApi(handler: (url: string) => JsonBody | Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
    const result = handler(requestUrl(input));
    return Promise.resolve(result instanceof Response ? result : Response.json(result));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function pageHandler(rows: readonly AdminAuditRowWire[]): (url: string) => JsonBody {
  return (url) => {
    if (url.includes('/admin/ops')) return CATALOG;
    return { rows, nextCursor: null };
  };
}

function renderScreen(
  filters: AuditFilters = {},
  onFiltersChange: (next: AuditFilters) => void = vi.fn()
): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <AuditTrailScreen filters={filters} onFiltersChange={onFiltersChange} />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('AuditTrailScreen', () => {
  it('renders the newest-first trail table', async () => {
    stubApi(pageHandler([ROW_A, ROW_B]));
    renderScreen();
    expect(await screen.findByText('user.lock')).toBeInTheDocument();
    expect(screen.getByText('wallet.credit')).toBeInTheDocument();
  });

  it('applies the filter form through onFiltersChange (URL ownership stays outside)', async () => {
    stubApi(pageHandler([ROW_A]));
    const onFiltersChange = vi.fn();
    renderScreen({}, onFiltersChange);
    await screen.findByText('user.lock');

    await userEvent.type(screen.getByLabelText('Action'), 'user.lock');
    await userEvent.type(screen.getByLabelText('From'), '2026-07-01T00:00:00Z');
    await userEvent.click(screen.getByTestId(TEST_IDS.adminAuditApplyFilters));

    expect(onFiltersChange).toHaveBeenCalledWith({
      action: 'user.lock',
      from: '2026-07-01T00:00:00.000Z',
    });
  });

  it('drops an unparseable datetime instead of sending it', async () => {
    stubApi(pageHandler([ROW_A]));
    const onFiltersChange = vi.fn();
    renderScreen({}, onFiltersChange);
    await screen.findByText('user.lock');

    await userEvent.type(screen.getByLabelText('From'), 'not a date');
    await userEvent.click(screen.getByTestId(TEST_IDS.adminAuditApplyFilters));
    expect(onFiltersChange).toHaveBeenCalledWith({});
  });

  it('shows active filters as removable pills', async () => {
    stubApi(pageHandler([ROW_A]));
    const onFiltersChange = vi.fn();
    renderScreen({ actor: 'founder@hushbox.test', action: 'user.lock' }, onFiltersChange);
    await screen.findByText('user.lock');

    const pills = screen.getAllByTestId(TEST_IDS.adminAuditFilterPill);
    expect(pills).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Remove actor filter' }));
    expect(onFiltersChange).toHaveBeenCalledWith({ action: 'user.lock' });
  });

  it('sends the active filters with the search request', async () => {
    const fetchMock = stubApi(pageHandler([ROW_A]));
    renderScreen({ action: 'user.lock' });
    await screen.findByText('user.lock');
    expect(
      fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes('action=user.lock'))
    ).toBe(true);
  });

  it('opens the drawer from a row and steps between rows with arrow keys', async () => {
    stubApi(pageHandler([ROW_A, ROW_B]));
    renderScreen();
    await screen.findByText('user.lock');

    await userEvent.click(screen.getAllByTestId(TEST_IDS.adminAuditInspect)[0]!);
    const drawer = screen.getByTestId(TEST_IDS.adminAuditDrawer);
    expect(within(drawer).getByText(ROW_A.id)).toBeInTheDocument();

    await userEvent.keyboard('{ArrowDown}');
    expect(
      within(screen.getByTestId(TEST_IDS.adminAuditDrawer)).getByText('wallet.credit')
    ).toBeInTheDocument();

    // Clamped at the last row: another ArrowDown stays put.
    await userEvent.keyboard('{ArrowDown}');
    expect(
      within(screen.getByTestId(TEST_IDS.adminAuditDrawer)).getByText('wallet.credit')
    ).toBeInTheDocument();

    await userEvent.keyboard('{ArrowUp}');
    expect(
      within(screen.getByTestId(TEST_IDS.adminAuditDrawer)).getByText('user.lock')
    ).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId(TEST_IDS.adminAuditDrawer)).not.toBeInTheDocument();
  });

  it('jumps to the paired row when it is loaded', async () => {
    const undone = auditRow({ undoneBy: ROW_B.id });
    const undoRow = { ...ROW_B, undoes: undone.id };
    stubApi(pageHandler([undone, undoRow]));
    renderScreen();
    await screen.findByText('user.lock');

    await userEvent.click(screen.getAllByTestId(TEST_IDS.adminAuditInspect)[0]!);
    await userEvent.click(screen.getByRole('button', { name: /undone by/i }));
    expect(
      within(screen.getByTestId(TEST_IDS.adminAuditDrawer)).getByText('wallet.credit')
    ).toBeInTheDocument();
  });

  it('loads more with the cursor', async () => {
    stubApi((url) => {
      if (url.includes('/admin/ops')) return CATALOG;
      if (url.includes('cursor=')) return { rows: [ROW_B], nextCursor: null };
      return { rows: [ROW_A], nextCursor: ROW_A.id };
    });
    renderScreen();
    await screen.findByText('user.lock');

    await userEvent.click(screen.getByTestId(TEST_IDS.adminAuditLoadMore));
    await waitFor(() => {
      expect(screen.getByText('wallet.credit')).toBeInTheDocument();
    });
  });

  it('teaches in the empty state', async () => {
    stubApi(pageHandler([]));
    renderScreen({ action: 'nope' });
    expect(await screen.findByTestId(TEST_IDS.adminAuditEmpty)).toHaveTextContent(/audit row/i);
  });

  it('shows the rate-limited notice on a 429 (240 per hour actor cap)', async () => {
    stubApi((url) => {
      if (url.includes('/admin/ops')) return CATALOG;
      return Response.json(
        { code: 'RATE_LIMITED', details: { retryAfterSeconds: 9 } },
        { status: 429 }
      );
    });
    renderScreen();
    expect(await screen.findByTestId(TEST_IDS.adminRateLimited)).toBeInTheDocument();
  });

  it('shows a plain error state on a non-429 failure', async () => {
    stubApi((url) => {
      if (url.includes('/admin/ops')) return CATALOG;
      return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
    });
    renderScreen();
    expect(await screen.findByText('Failed to load the audit trail.')).toBeInTheDocument();
  });

  it('shows a loading state while the first page is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    );
    renderScreen();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});

describe('stepAuditSelection', () => {
  it('returns the neighbour, clamped at both ends', () => {
    const rows = [ROW_A, ROW_B];
    expect(stepAuditSelection(rows, ROW_A.id, 1)).toBe(ROW_B.id);
    expect(stepAuditSelection(rows, ROW_B.id, 1)).toBe(ROW_B.id);
    expect(stepAuditSelection(rows, ROW_A.id, -1)).toBe(ROW_A.id);
  });

  it('keeps the current selection when no rows are loaded', () => {
    expect(stepAuditSelection([], ROW_A.id, 1)).toBe(ROW_A.id);
  });
});

describe('AuditTrailScreen extras', () => {
  it('ignores a jump to a row that is not loaded', async () => {
    const undone = auditRow({ undoneBy: '018f6b3a-0000-7000-8000-00000000dddd' });
    stubApi(pageHandler([undone]));
    renderScreen();
    await screen.findByText('user.lock');

    await userEvent.click(screen.getByTestId(TEST_IDS.adminAuditInspect));
    await userEvent.click(screen.getByRole('button', { name: /undone by/i }));
    expect(
      within(screen.getByTestId(TEST_IDS.adminAuditDrawer)).getByText('user.lock')
    ).toBeInTheDocument();
  });

  it('retries a rate-limited search from the notice', async () => {
    let limited = true;
    const fetchMock = stubApi((url) => {
      if (url.includes('/admin/ops')) return CATALOG;
      if (limited) {
        return Response.json(
          { code: 'RATE_LIMITED', details: { retryAfterSeconds: 30 } },
          { status: 429 }
        );
      }
      return { rows: [ROW_A], nextCursor: null };
    });
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminRateLimited);
    limited = false;

    await userEvent.click(screen.getByTestId(TEST_IDS.adminRateLimitedRetry));
    await screen.findByText('user.lock');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
