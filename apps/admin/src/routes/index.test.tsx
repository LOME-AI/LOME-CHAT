import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { Route } from './index.js';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({
      children,
      to,
      ...props
    }: {
      children: React.ReactNode;
      to: string;
    }): React.JSX.Element => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER_ID = '018f6b3a-0000-7000-8000-000000000002';
const TODAY_ISO = new Date().toISOString();

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

const LOCK_ROW = {
  id: '018f6b3a-0000-7000-8000-000000000001',
  actor: 'founder@hushbox.test',
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
  createdAt: TODAY_ISO,
};

const OLD_ROW = {
  ...LOCK_ROW,
  id: '018f6b3a-0000-7000-8000-000000000009',
  createdAt: '2020-01-01T00:00:00.000Z',
};

const DASHBOARD = {
  jobs: { pending: 4, running: 1, dead: 2, discarded: 3 },
  recentActions: [LOCK_ROW, OLD_ROW],
};

function stubFetchWith(dashboardResponse: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes('/admin/ops')) {
      return Promise.resolve(Response.json(CATALOG));
    }
    return Promise.resolve(dashboardResponse());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderScreen(): void {
  const Component = (Route as { options?: { component?: React.ComponentType } }).options?.component;
  if (Component === undefined) {
    throw new Error('dashboard route has no component');
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

describe('Dashboard', () => {
  it('renders health tiles from the jobs counts', async () => {
    stubFetchWith(() => Response.json(DASHBOARD));
    renderScreen();

    const tiles = await screen.findByTestId(TEST_IDS.adminDashboardTiles);
    expect(tiles).toHaveTextContent(/dead jobs/i);
    expect(tiles).toHaveTextContent(/backlog/i);
    expect(tiles).toHaveTextContent(/discarded/i);
    // Backlog = pending + running.
    expect(within(tiles).getByText('5')).toBeInTheDocument();
  });

  it('links the dead-jobs tile to the Jobs screen with attention styling when dead > 0', async () => {
    stubFetchWith(() => Response.json(DASHBOARD));
    renderScreen();

    const tiles = await screen.findByTestId(TEST_IDS.adminDashboardTiles);
    const dead = within(tiles).getByRole('link', { name: /dead jobs/i });
    expect(dead).toHaveAttribute('href', '/jobs');
    expect(within(dead).getByText('2')).toHaveClass('text-destructive');
  });

  it('does not style the dead-jobs count as attention when zero', async () => {
    stubFetchWith(() => Response.json({ ...DASHBOARD, jobs: { ...DASHBOARD.jobs, dead: 0 } }));
    renderScreen();

    const tiles = await screen.findByTestId(TEST_IDS.adminDashboardTiles);
    const dead = within(tiles).getByRole('link', { name: /dead jobs/i });
    expect(within(dead).getByText('0')).not.toHaveClass('text-destructive');
  });

  it('counts only today in the actions-today tile', async () => {
    stubFetchWith(() => Response.json(DASHBOARD));
    renderScreen();

    const tiles = await screen.findByTestId(TEST_IDS.adminDashboardTiles);
    const today = within(tiles)
      .getByText(/actions today/i)
      .closest('div');
    expect(today).not.toBeNull();
    expect(within(today as HTMLElement).getByText('1')).toBeInTheDocument();
  });

  it('renders the user search front and center', async () => {
    stubFetchWith(() => Response.json(DASHBOARD));
    renderScreen();

    expect(await screen.findByTestId(TEST_IDS.adminUserSearch)).toBeInTheDocument();
  });

  it('renders the recent actions feed with an Undo affordance', async () => {
    stubFetchWith(() => Response.json(DASHBOARD));
    renderScreen();

    const recent = await screen.findByTestId(TEST_IDS.adminDashboardRecent);
    expect(recent).toHaveTextContent('user.lock');
    expect(recent).toHaveTextContent('founder@hushbox.test');
    expect(recent).toHaveTextContent('dispute received');
    const undos = await within(recent).findAllByTestId(TEST_IDS.adminAuditUndo);
    expect(undos.length).toBeGreaterThan(0);
  });

  it('opens the inverse op prefilled from a feed Undo', async () => {
    const user = userEvent.setup();
    stubFetchWith(() => Response.json(DASHBOARD));
    renderScreen();

    const recent = await screen.findByTestId(TEST_IDS.adminDashboardRecent);
    const [undo] = await within(recent).findAllByTestId(TEST_IDS.adminAuditUndo);
    await user.click(undo!);

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Unlock account');
    expect(within(modal).getByLabelText('userId')).toHaveValue(USER_ID);
  });

  it('shows an empty feed state when there are no recent actions', async () => {
    stubFetchWith(() => Response.json({ ...DASHBOARD, recentActions: [] }));
    renderScreen();

    const recent = await screen.findByTestId(TEST_IDS.adminDashboardRecent);
    expect(recent).toHaveTextContent(/no admin actions/i);
  });

  it('shows a loading state while the query is pending', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    );
    renderScreen();

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows an error state when the query fails', async () => {
    stubFetchWith(() => Response.json({ code: 'UNAVAILABLE' }, { status: 503 }));
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });
  });

  it('shows the rate-limited state with a working retry on 429', async () => {
    const fetchMock = stubFetchWith(() =>
      Response.json({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 9 } }, { status: 429 })
    );
    renderScreen();

    const notice = await screen.findByTestId(TEST_IDS.adminRateLimited);
    expect(notice).toHaveTextContent('9s');

    const before = fetchMock.mock.calls.length;
    const user = userEvent.setup();
    await user.click(screen.getByTestId(TEST_IDS.adminRateLimitedRetry));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });
  });
});
