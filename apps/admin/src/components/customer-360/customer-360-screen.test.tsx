import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { Customer360Screen } from './customer-360-screen.js';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER_ID = '018f6b3a-0000-7000-8000-000000000002';

const WALLET_ID = '018f6b3a-0000-7000-8000-000000000010';

const VIEW = {
  user: {
    id: USER_ID,
    email: 'user@example.com',
    username: 'user',
    emailVerified: true,
    totpEnabled: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    lockedAt: null,
    lockReason: null,
    hasAcknowledgedPhrase: false,
  },
  panels: {
    money: {
      ok: true,
      data: {
        balance: {
          purchasedNanoUsd: '10000000000',
          freeNanoUsd: '50000000',
          allowance: {
            day: '2026-07-15',
            limitNanoUsd: '100000000',
            spentNanoUsd: '50000000',
            remainingNanoUsd: '50000000',
          },
        },
        wallets: [
          { id: WALLET_ID, type: 'purchased', balanceNanoUsd: '10000000000' },
          {
            id: '018f6b3a-0000-7000-8000-000000000011',
            type: 'free',
            balanceNanoUsd: '50000000',
          },
        ],
        recentLedger: [
          {
            createdAt: '2026-07-14T10:00:00.000Z',
            kind: 'charge',
            amountNanoUsd: '-2500000000',
            balanceAfterNanoUsd: '10000000000',
          },
        ],
      },
    },
    usage: {
      ok: true,
      data: {
        models: [
          {
            modelId: 'openai/gpt-5',
            totalNanoUsd: '900000000',
            recordCount: 3,
            estimatedCount: 1,
          },
        ],
      },
    },
    conversations: { ok: true, data: { owned: 4, activeMemberships: 6 } },
    devices: {
      ok: true,
      data: { count: 3, tokens: [{ platform: 'ios' }, { platform: 'ios' }, { platform: 'web' }] },
    },
    jobs: {
      ok: true,
      data: {
        jobs: [
          {
            id: '018f6b3a-0000-7000-8000-000000000003',
            type: 'media.reclaimUser.v1',
            shard: 'bulk',
            status: 'dead',
            discarded: false,
            failures: 8,
            claims: 9,
            payload: {},
            errors: [],
            nextAttemptAt: '2026-07-14T11:00:00.000Z',
            createdAt: '2026-07-14T09:00:00.000Z',
            finishedAt: null,
          },
        ],
      },
    },
    adminHistory: { ok: false, error: 'unavailable' },
  },
};

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
      name: 'wallet.clawback',
      title: 'Claw back wallet',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'wallet.credit',
      fields: ['walletId', 'amountNanoUsd', 'reason'],
    },
  ],
};

function stubFetchWith(overviewResponse: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes('/admin/ops')) {
      return Promise.resolve(Response.json(CATALOG));
    }
    return Promise.resolve(overviewResponse());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderScreen(q?: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <Customer360Screen q={q} />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('Customer360Screen', () => {
  it('renders the search-first empty state without a query', () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen();

    expect(screen.getByTestId(TEST_IDS.adminC360Empty)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminUserSearch)).toBeInTheDocument();
  });

  it('renders per-panel skeletons while loading', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    );
    renderScreen('user@example.com');

    expect(screen.getByTestId(TEST_IDS.adminC360Panels)).toBeInTheDocument();
    expect(screen.getByText('Money')).toBeInTheDocument();
    expect(screen.getByText('Devices')).toBeInTheDocument();
  });

  it('renders a clear miss state with the searched term on 404', async () => {
    stubFetchWith(() => Response.json({ code: 'NOT_FOUND' }, { status: 404 }));
    renderScreen('missing@example.com');

    const miss = await screen.findByTestId(TEST_IDS.adminC360Miss);
    expect(miss).toHaveTextContent('missing@example.com');
    expect(miss).toHaveTextContent(/no user/i);
  });

  it('renders the rate-limited state with a working retry on 429', async () => {
    const fetchMock = stubFetchWith(() =>
      Response.json({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 7 } }, { status: 429 })
    );
    renderScreen('user@example.com');

    const notice = await screen.findByTestId(TEST_IDS.adminRateLimited);
    expect(notice).toHaveTextContent('7s');

    const before = fetchMock.mock.calls.length;
    const user = userEvent.setup();
    await user.click(screen.getByTestId(TEST_IDS.adminRateLimitedRetry));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('renders a generic failure state on other errors', async () => {
    stubFetchWith(() => Response.json({ code: 'UNAVAILABLE' }, { status: 503 }));
    renderScreen('user@example.com');

    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('renders the header and every panel from a loaded view', async () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen('user@example.com');

    const header = await screen.findByTestId(TEST_IDS.adminC360Header);
    expect(header).toHaveTextContent('user@example.com');

    const panels = screen.getByTestId(TEST_IDS.adminC360Panels);
    expect(panels).toHaveTextContent('$10.00');
    expect(panels).toHaveTextContent('-$2.50');
    expect(panels).toHaveTextContent('openai/gpt-5');
    expect(panels).toHaveTextContent('media.reclaimUser.v1');
    expect(panels).toHaveTextContent('4');
    expect(panels).toHaveTextContent('6');
  });

  it('isolates a failed panel to an inline error, never blanking the page', async () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen('user@example.com');

    await screen.findByTestId(TEST_IDS.adminC360Header);
    const error = screen.getByTestId(TEST_IDS.adminPanelError);
    expect(error).toHaveTextContent('unavailable');
    expect(screen.getByText('openai/gpt-5')).toBeInTheDocument();
  });

  it('renders identity facts including the unacknowledged recovery phrase', async () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen('user@example.com');

    await screen.findByTestId(TEST_IDS.adminC360Header);
    const panels = screen.getByTestId(TEST_IDS.adminC360Panels);
    expect(panels).toHaveTextContent(/totp/i);
    expect(panels).toHaveTextContent(/recovery phrase/i);
  });

  it('renders the teaching state for a partial term without calling the API', () => {
    const fetchMock = stubFetchWith(() => Response.json(VIEW));
    renderScreen('alice');

    const invalid = screen.getByTestId(TEST_IDS.adminC360Invalid);
    expect(invalid).toHaveTextContent('alice');
    expect(invalid).toHaveTextContent(
      'it needs a full email address or user id (uuid). Partial matches are not supported.'
    );
    const overviewCalls = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input as string | URL | Request).includes('/admin/users/overview')
    );
    expect(overviewCalls).toHaveLength(0);
  });

  it('initializes the find-a-user input from the deep-linked query', () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen('user@example.com');

    expect(screen.getByTestId(TEST_IDS.adminUserSearchInput)).toHaveValue('user@example.com');
  });

  it('treats a whitespace-only query as the empty state', () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen('   ');

    expect(screen.getByTestId(TEST_IDS.adminC360Empty)).toBeInTheDocument();
  });

  it('renders panel empty states and the discarded job marker', async () => {
    const emptyView = {
      ...VIEW,
      user: { ...VIEW.user, emailVerified: false, totpEnabled: false, lockedAt: null },
      panels: {
        ...VIEW.panels,
        money: {
          ok: true,
          data: {
            ...(VIEW.panels.money as { data: object }).data,
            wallets: [],
            recentLedger: [],
          },
        },
        usage: { ok: true, data: { models: [] } },
        jobs: {
          ok: true,
          data: {
            jobs: [
              {
                ...(VIEW.panels.jobs as { data: { jobs: object[] } }).data.jobs[0],
                discarded: true,
                finishedAt: '2026-07-14T12:00:00.000Z',
              },
            ],
          },
        },
        adminHistory: { ok: true, data: { actions: [] } },
      },
    };
    stubFetchWith(() => Response.json(emptyView));
    renderScreen('user@example.com');

    await screen.findByTestId(TEST_IDS.adminC360Header);
    const panels = screen.getByTestId(TEST_IDS.adminC360Panels);
    expect(panels).toHaveTextContent(/no ledger entries/i);
    expect(
      within(panels).queryByRole('button', { name: 'Copy wallet id' })
    ).not.toBeInTheDocument();
    expect(panels).toHaveTextContent(/no usage recorded/i);
    expect(panels).toHaveTextContent(/no admin actions/i);
    expect(panels).toHaveTextContent('(discarded)');
  });

  it('renders the jobs empty state', async () => {
    const view = { ...VIEW, panels: { ...VIEW.panels, jobs: { ok: true, data: { jobs: [] } } } };
    stubFetchWith(() => Response.json(view));
    renderScreen('user@example.com');

    await screen.findByTestId(TEST_IDS.adminC360Header);
    expect(screen.getByTestId(TEST_IDS.adminC360Panels)).toHaveTextContent(/no jobs touching/i);
  });

  it('renders wallet identity rows inside the money panel', async () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen('user@example.com');

    await screen.findByTestId(TEST_IDS.adminC360Header);
    const panels = screen.getByTestId(TEST_IDS.adminC360Panels);
    expect(panels).toHaveTextContent(WALLET_ID);
    expect(panels).toHaveTextContent('purchased');
    expect(panels).toHaveTextContent('free');
    expect(within(panels).getAllByRole('button', { name: 'Copy wallet id' })).toHaveLength(2);
  });

  it('opens Credit prefilled with the row wallet id', async () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen('user@example.com');
    const user = userEvent.setup();

    await screen.findByTestId(TEST_IDS.adminC360Header);
    const panels = screen.getByTestId(TEST_IDS.adminC360Panels);
    await user.click(within(panels).getAllByRole('button', { name: 'Credit' })[0]!);

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Credit wallet');
    expect(within(modal).getByLabelText('walletId')).toHaveValue(WALLET_ID);
  });

  it('opens Claw back prefilled with the row wallet id', async () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen('user@example.com');
    const user = userEvent.setup();

    await screen.findByTestId(TEST_IDS.adminC360Header);
    const panels = screen.getByTestId(TEST_IDS.adminC360Panels);
    await user.click(within(panels).getAllByRole('button', { name: 'Claw back' })[0]!);

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Claw back wallet');
    expect(within(modal).getByLabelText('walletId')).toHaveValue(WALLET_ID);
  });

  it('renders the devices panel with the count and platform tallies', async () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen('user@example.com');

    await screen.findByTestId(TEST_IDS.adminC360Header);
    const panels = screen.getByTestId(TEST_IDS.adminC360Panels);
    expect(panels).toHaveTextContent('Devices');
    expect(panels).toHaveTextContent('ios');
    expect(panels).toHaveTextContent('web');
    expect(panels).toHaveTextContent('3');
  });

  it('renders the devices empty state', async () => {
    const view = {
      ...VIEW,
      panels: { ...VIEW.panels, devices: { ok: true, data: { count: 0, tokens: [] } } },
    };
    stubFetchWith(() => Response.json(view));
    renderScreen('user@example.com');

    await screen.findByTestId(TEST_IDS.adminC360Header);
    expect(screen.getByTestId(TEST_IDS.adminC360Panels)).toHaveTextContent(
      /no registered devices/i
    );
  });

  it('notes that conversation content is unrepresentable', async () => {
    stubFetchWith(() => Response.json(VIEW));
    renderScreen('user@example.com');

    await screen.findByTestId(TEST_IDS.adminC360Header);
    const panels = screen.getByTestId(TEST_IDS.adminC360Panels);
    expect(panels).toHaveTextContent(/ciphertext/i);
  });
});
