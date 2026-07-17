import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { ModelsScreen } from './models-screen.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  ops: [
    {
      name: 'model.disable',
      title: 'Disable model',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'model.enable',
      fields: ['modelId', 'reason'],
    },
    {
      name: 'model.enable',
      title: 'Enable model',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'model.disable',
      fields: ['modelId', 'reason'],
    },
  ],
};

const MODELS = {
  models: [
    {
      modelId: 'anthropic/claude-4',
      name: 'Claude 4',
      family: 'language',
      zdrReachable: true,
      adminDisabledAt: null,
    },
    {
      modelId: 'broken/descriptor',
      name: null,
      family: null,
      zdrReachable: null,
      adminDisabledAt: '2026-07-13T12:00:00.000Z',
    },
    {
      modelId: 'someai/video-gen',
      name: 'Video Gen',
      family: 'video',
      zdrReachable: false,
      adminDisabledAt: null,
    },
  ],
  truncated: false,
};

function stubFetchWith(modelsResponse: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes('/admin/ops')) {
      return Promise.resolve(Response.json(CATALOG));
    }
    return Promise.resolve(modelsResponse());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <ModelsScreen />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('ModelsScreen', () => {
  it('renders a loading state while the catalog is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    );
    renderScreen();

    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders the rate-limited state with a working retry on 429', async () => {
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

  it('renders a generic failure state on other errors', async () => {
    stubFetchWith(() => Response.json({ code: 'UNAVAILABLE' }, { status: 503 }));
    renderScreen();

    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('renders a teaching empty state when the catalog has no rows', async () => {
    stubFetchWith(() => Response.json({ models: [], truncated: false }));
    renderScreen();

    const empty = await screen.findByTestId(TEST_IDS.adminModelsEmpty);
    expect(empty).toHaveTextContent(/auto-discovered/i);
    expect(empty).toHaveTextContent(/refresh/i);
  });

  it('renders the dense table: copyable id, name fallback, family, ZDR and status chips', async () => {
    stubFetchWith(() => Response.json(MODELS));
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminModelsTable);
    expect(table).toHaveTextContent('anthropic/claude-4');
    expect(table).toHaveTextContent('Claude 4');
    expect(table).toHaveTextContent('language');
    expect(
      within(table).getAllByRole('button', { name: 'Copy model id' }).length
    ).toBeGreaterThanOrEqual(3);

    // Null projections (corrupt stored descriptor) render empty cells (the
    // dashboard feed precedent), never a placeholder glyph.
    const brokenRow = within(table).getByText('broken/descriptor').closest('tr');
    expect(brokenRow).not.toBeNull();
    expect(brokenRow).not.toHaveTextContent('—');
    expect(brokenRow).toHaveTextContent(/zdr unknown/i);

    // The kill-switch chip carries the ISO date; enabled rows read Enabled.
    expect(brokenRow).toHaveTextContent('Disabled 2026-07-13');
    const liveRow = within(table).getByText('anthropic/claude-4').closest('tr');
    expect(liveRow).toHaveTextContent('Enabled');
    expect(liveRow?.textContent).not.toMatch(/not zdr/i);

    // ZDR-unreachable renders the negative chip.
    const videoRow = within(table).getByText('someai/video-gen').closest('tr');
    expect(videoRow).toHaveTextContent(/not zdr/i);
  });

  it('narrows the rows with the type-to-filter input over id and name', async () => {
    stubFetchWith(() => Response.json(MODELS));
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminModelsTable);
    expect(within(table).getAllByRole('row')).toHaveLength(4);

    const user = userEvent.setup();
    await user.type(screen.getByTestId(TEST_IDS.adminModelsFilter), 'claude');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(table).toHaveTextContent('anthropic/claude-4');
    expect(table).not.toHaveTextContent('someai/video-gen');

    await user.clear(screen.getByTestId(TEST_IDS.adminModelsFilter));
    await user.type(screen.getByTestId(TEST_IDS.adminModelsFilter), 'Video Gen');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(table).toHaveTextContent('someai/video-gen');
  });

  it('shows a no-match state when the filter excludes every row', async () => {
    stubFetchWith(() => Response.json(MODELS));
    renderScreen();

    await screen.findByTestId(TEST_IDS.adminModelsTable);
    const user = userEvent.setup();
    await user.type(screen.getByTestId(TEST_IDS.adminModelsFilter), 'zzz-no-such-model');
    expect(screen.queryByTestId(TEST_IDS.adminModelsTable)).not.toBeInTheDocument();
    expect(screen.getByText(/no models match/i)).toBeInTheDocument();
  });

  it('styles the row-level Disable as a neutral button (red lives in the confirm step)', async () => {
    stubFetchWith(() => Response.json(MODELS));
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminModelsTable);
    const disable = within(table).getAllByTestId(TEST_IDS.adminModelDisable)[0]!;
    expect(disable.className).not.toContain('text-destructive');
  });

  it('omits the truncated indicator when the page is complete', async () => {
    stubFetchWith(() => Response.json(MODELS));
    renderScreen();

    await screen.findByTestId(TEST_IDS.adminModelsTable);
    expect(screen.queryByTestId(TEST_IDS.adminModelsTruncated)).not.toBeInTheDocument();
  });

  it('shows the truncated indicator when the server cut at its cap', async () => {
    stubFetchWith(() => Response.json({ ...MODELS, truncated: true }));
    renderScreen();

    const truncated = await screen.findByTestId(TEST_IDS.adminModelsTruncated);
    expect(truncated).toHaveTextContent(/truncated/i);
  });

  it('opens Disable prefilled with the model id for an enabled row', async () => {
    stubFetchWith(() => Response.json(MODELS));
    renderScreen();
    const user = userEvent.setup();

    const table = await screen.findByTestId(TEST_IDS.adminModelsTable);
    const row = within(table).getByText('anthropic/claude-4').closest('tr');
    if (row === null) throw new Error('expected a table row');
    await user.click(within(row as HTMLElement).getByTestId(TEST_IDS.adminModelDisable));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Disable model');
    expect(within(modal).getByLabelText('modelId')).toHaveValue('anthropic/claude-4');
  });

  it('offers Enable instead of Disable for a kill-switched row', async () => {
    stubFetchWith(() => Response.json(MODELS));
    renderScreen();
    const user = userEvent.setup();

    const table = await screen.findByTestId(TEST_IDS.adminModelsTable);
    const row = within(table).getByText('broken/descriptor').closest('tr');
    if (row === null) throw new Error('expected a table row');
    expect(
      within(row as HTMLElement).queryByTestId(TEST_IDS.adminModelDisable)
    ).not.toBeInTheDocument();
    await user.click(within(row as HTMLElement).getByTestId(TEST_IDS.adminModelEnable));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Enable model');
    expect(within(modal).getByLabelText('modelId')).toHaveValue('broken/descriptor');
  });

  it('refetches the catalog from the Refresh button', async () => {
    const fetchMock = stubFetchWith(() => Response.json(MODELS));
    renderScreen();

    await screen.findByTestId(TEST_IDS.adminModelsTable);
    const before = fetchMock.mock.calls.length;
    const user = userEvent.setup();
    await user.click(screen.getByTestId(TEST_IDS.adminModelsRefresh));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });
  });
});
