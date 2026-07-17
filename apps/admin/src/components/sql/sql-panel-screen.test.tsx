import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { SqlPanelScreen } from './sql-panel-screen.js';

afterEach(() => {
  vi.unstubAllGlobals();
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

const PAGE = {
  rows: [
    { id: 'job-1', failures: 3, finished_at: null },
    { id: 'job-2', failures: 0, finished_at: '2026-07-15T00:00:00.000Z' },
  ],
  rowCount: 2,
  truncated: false,
};

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SqlPanelScreen />
    </QueryClientProvider>
  );
}

async function run(text: string): Promise<void> {
  await userEvent.type(screen.getByTestId(TEST_IDS.adminSqlEditor), text);
  await userEvent.click(screen.getByTestId(TEST_IDS.adminSqlRun));
}

describe('SqlPanelScreen', () => {
  it('shows the persistent read-only badge and an idle empty state', () => {
    stubApi(() => PAGE);
    renderScreen();
    expect(screen.getByTestId(TEST_IDS.adminSqlBadge)).toHaveTextContent(/read-only/i);
    expect(screen.getByText(/SELECT-only/)).toBeInTheDocument();
  });

  it('runs a query and renders the results grid with a status line', async () => {
    const fetchMock = stubApi(() => PAGE);
    renderScreen();
    await run('SELECT * FROM jobs');

    const results = await screen.findByTestId(TEST_IDS.adminSqlResults);
    expect(within(results).getByText('id')).toBeInTheDocument();
    expect(within(results).getByText('job-1')).toBeInTheDocument();
    expect(within(results).getByText('null')).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminSqlStatus)).toHaveTextContent('2 rows');
    expect(screen.queryByTestId(TEST_IDS.adminSqlTruncated)).not.toBeInTheDocument();
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain('/api/admin/sql');
  });

  it('runs on Ctrl+Enter from the editor', async () => {
    const fetchMock = stubApi(() => PAGE);
    renderScreen();
    await userEvent.type(screen.getByTestId(TEST_IDS.adminSqlEditor), 'SELECT 1');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it('does not run an empty editor', async () => {
    const fetchMock = stubApi(() => PAGE);
    renderScreen();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminSqlRun));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the truncation chip only when the server truncated', async () => {
    stubApi(() => ({ rows: [{ id: 'x' }], rowCount: 200, truncated: true }));
    renderScreen();
    await run('SELECT * FROM ledger_entries');
    expect(await screen.findByTestId(TEST_IDS.adminSqlTruncated)).toHaveTextContent(/200/);
  });

  it('renders a zero-row result honestly', async () => {
    stubApi(() => ({ rows: [], rowCount: 0, truncated: false }));
    renderScreen();
    await run('SELECT 1 WHERE false');
    expect(await screen.findByTestId(TEST_IDS.adminSqlStatus)).toHaveTextContent('0 rows');
  });

  it('renders the server error body verbatim in a persistent panel, never a toast', async () => {
    stubApi(() => Response.json({ code: 'VALIDATION' }, { status: 400 }));
    renderScreen();
    await run('SELECT secret FROM vault');

    const panel = await screen.findByTestId(TEST_IDS.adminSqlError);
    expect(panel).toHaveTextContent('VALIDATION');
    expect(panel.textContent).toContain('"code"');
  });

  it('explains that the panel runs SELECT statements only when the text is not a SELECT', async () => {
    stubApi(() => Response.json({ code: 'VALIDATION' }, { status: 400 }));
    renderScreen();
    await run('  update jobs set failures = 0');

    const panel = await screen.findByTestId(TEST_IDS.adminSqlError);
    expect(panel).toHaveTextContent(
      'This panel runs SELECT statements only: the write-proof role rejects everything else.'
    );
  });

  it('names the failed query in the lead-in when a SELECT is rejected', async () => {
    stubApi(() => Response.json({ code: 'VALIDATION' }, { status: 400 }));
    renderScreen();
    await run('SELECT * FROM nope');

    const panel = await screen.findByTestId(TEST_IDS.adminSqlError);
    expect(panel).toHaveTextContent(/query failed/i);
    expect(panel.textContent).toContain('"code"');
  });

  it('clears the error panel on the next successful run', async () => {
    let fail = true;
    stubApi(() => (fail ? Response.json({ code: 'VALIDATION' }, { status: 400 }) : PAGE));
    renderScreen();
    await run('bad');
    await screen.findByTestId(TEST_IDS.adminSqlError);

    fail = false;
    await userEvent.click(screen.getByTestId(TEST_IDS.adminSqlRun));
    await screen.findByTestId(TEST_IDS.adminSqlResults);
    expect(screen.queryByTestId(TEST_IDS.adminSqlError)).not.toBeInTheDocument();
  });

  it('clears the previous results grid when the next run fails', async () => {
    let fail = false;
    stubApi(() => (fail ? Response.json({ code: 'VALIDATION' }, { status: 400 }) : PAGE));
    renderScreen();
    await run('SELECT type FROM jobs');
    await screen.findByTestId(TEST_IDS.adminSqlResults);

    fail = true;
    await userEvent.click(screen.getByTestId(TEST_IDS.adminSqlRun));
    await screen.findByTestId(TEST_IDS.adminSqlError);

    // Stale rows must never render beneath a failing query's error panel.
    expect(screen.queryByTestId(TEST_IDS.adminSqlResults)).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.adminSqlStatus)).not.toBeInTheDocument();
  });

  it('shows the rate-limited notice on a 429 (120 per hour cap)', async () => {
    stubApi(() =>
      Response.json({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 8 } }, { status: 429 })
    );
    renderScreen();
    await run('SELECT 1');
    expect(await screen.findByTestId(TEST_IDS.adminRateLimited)).toBeInTheDocument();
  });

  it('keeps a most-recent-first history of executed snapshots and restores on click', async () => {
    stubApi(() => PAGE);
    renderScreen();
    await run('SELECT 1');
    await screen.findByTestId(TEST_IDS.adminSqlResults);

    const editor = screen.getByTestId(TEST_IDS.adminSqlEditor);
    await userEvent.clear(editor);
    await userEvent.type(editor, 'SELECT 2');
    await userEvent.click(screen.getByTestId(TEST_IDS.adminSqlRun));
    await waitFor(() => {
      expect(screen.getAllByTestId(TEST_IDS.adminSqlHistoryItem)).toHaveLength(2);
    });

    const items = screen.getAllByTestId(TEST_IDS.adminSqlHistoryItem);
    expect(items[0]).toHaveTextContent('SELECT 2');
    expect(items[1]).toHaveTextContent('SELECT 1');

    // The history stores the executed snapshot, never the live editor text.
    await userEvent.clear(editor);
    await userEvent.type(editor, 'draft not run');
    await userEvent.click(items[1]!);
    expect(screen.getByTestId(TEST_IDS.adminSqlEditor)).toHaveValue('SELECT 1');
  });

  it('dedupes an identical re-run to one history entry', async () => {
    stubApi(() => PAGE);
    renderScreen();
    await run('SELECT 1');
    await screen.findByTestId(TEST_IDS.adminSqlResults);
    await userEvent.click(screen.getByTestId(TEST_IDS.adminSqlRun));
    await waitFor(() => {
      expect(screen.getAllByTestId(TEST_IDS.adminSqlHistoryItem)).toHaveLength(1);
    });
  });
});

describe('SqlPanelScreen extras', () => {
  it('renders a transport failure as INTERNAL with a code-only body', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('network down')));
    vi.stubGlobal('fetch', fetchMock);
    renderScreen();
    await run('SELECT 1');

    const panel = await screen.findByTestId(TEST_IDS.adminSqlError);
    expect(panel).toHaveTextContent('INTERNAL');
  });

  it('re-runs the query from the rate-limited notice', async () => {
    let limited = true;
    const fetchMock = stubApi(() => {
      if (limited) {
        return Response.json(
          { code: 'RATE_LIMITED', details: { retryAfterSeconds: 30 } },
          { status: 429 }
        );
      }
      return PAGE;
    });
    renderScreen();
    await run('SELECT 1');
    await screen.findByTestId(TEST_IDS.adminRateLimited);
    limited = false;

    await userEvent.click(screen.getByTestId(TEST_IDS.adminRateLimitedRetry));
    await screen.findByTestId(TEST_IDS.adminSqlResults);
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});
