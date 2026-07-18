import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider, useRunOp } from './op-modal-provider.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  ops: [
    {
      name: 'user.unlock',
      title: 'Unlock account',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'user.lock',
      fields: ['userId', 'reason'],
    },
    {
      name: 'user.lock',
      title: 'Lock account',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'user.unlock',
      fields: ['userId', 'reason'],
    },
    {
      name: 'banner.set',
      title: 'Set banner',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'banner.set',
      fields: ['enabled', 'messages', 'reason'],
    },
  ],
};

interface AdminFetchRoutes {
  readonly prefill?: () => Response | Promise<Response>;
  readonly preview?: () => Response;
  readonly execute?: () => Response;
}

/** URL-dispatching fetch stub: catalog by default, per-route overrides. */
function stubAdminFetch(routes: AdminFetchRoutes = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes('/prefill')) {
      return Promise.resolve(
        routes.prefill?.() ?? Response.json({ code: 'NOT_FOUND' }, { status: 404 })
      );
    }
    if (url.includes('/preview')) {
      return Promise.resolve(
        routes.preview?.() ?? Response.json({ effects: [], inverseInput: null })
      );
    }
    if (url.includes('/execute')) {
      return Promise.resolve(
        routes.execute?.() ??
          Response.json({
            auditId: '01890a5c-0000-7000-8000-000000000001',
            effects: [],
            inverseInput: null,
          })
      );
    }
    return Promise.resolve(Response.json(CATALOG));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function prefillCalls(fetchMock: ReturnType<typeof vi.fn>): readonly string[] {
  return fetchMock.mock.calls
    .map((call) => requestUrl(call[0] as string | URL | Request))
    .filter((url) => url.includes('/prefill'));
}

function Launcher(): React.JSX.Element {
  const runOp = useRunOp();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          runOp({ opName: 'user.unlock' });
        }}
      >
        Launch
      </button>
      <button
        type="button"
        onClick={() => {
          runOp({ opName: 'user.lock' });
        }}
      >
        Launch other
      </button>
      <button
        type="button"
        onClick={() => {
          runOp({ opName: 'banner.set' });
        }}
      >
        Launch banner
      </button>
      <button
        type="button"
        onClick={() => {
          runOp({ opName: 'user.unlock', initialValues: { userId: 'seed-1' } });
        }}
      >
        Launch seeded
      </button>
    </>
  );
}

function renderProvider(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <Launcher />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('OpModalProvider', () => {
  it('does not fetch the catalog until an op flow starts', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderProvider();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId(TEST_IDS.adminOpModal)).not.toBeInTheDocument();
  });

  it('opens the OpModal for the requested op and closes it again', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(CATALOG)))
    );
    renderProvider();

    await user.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Unlock account' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.adminOpModal)).not.toBeInTheDocument();
    });
  });

  it('remounts the modal fresh when runOp fires while another flow is open', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(CATALOG)))
    );
    renderProvider();

    await user.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unlock account' })).toBeInTheDocument();
    });

    // fireEvent + getByText: the open modal Dialog marks outside content
    // aria-hidden and pointer-events:none, so role queries and userEvent's
    // pointer checks can't reach the launcher — the programmatic runOp path
    // (palette, screens) is what this exercises anyway.
    fireEvent.click(screen.getByText('Launch other'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Lock account' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Unlock account' })).not.toBeInTheDocument();
  });
});

describe('OpModalProvider prefill', () => {
  it('seeds a fresh op form from a 200 prefill with reason left blank', async () => {
    const user = userEvent.setup();
    stubAdminFetch({
      prefill: () =>
        Response.json({
          input: {
            enabled: true,
            messages: [
              {
                variant: 'info',
                text: 'Maintenance at noon',
                href: 'https://status.example/window',
                linkText: 'Details',
              },
            ],
            reason: 'hostile server-sent reason',
          },
        }),
    });
    renderProvider();

    await user.click(screen.getByRole('button', { name: 'Launch banner' }));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    });

    expect(screen.getByRole('switch', { name: 'enabled' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    const row = screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', 0));
    expect(within(row).getByLabelText('text')).toHaveValue('Maintenance at noon');
    expect(within(row).getByLabelText('href')).toHaveValue('https://status.example/window');
    expect(within(row).getByLabelText('linkText')).toHaveValue('Details');
    expect(screen.getByLabelText('reason')).toHaveValue('');
  });

  it('opens a blank form when the prefill probe 404s', async () => {
    const user = userEvent.setup();
    stubAdminFetch();
    renderProvider();

    await user.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    });

    expect(screen.getByLabelText('userId')).toHaveValue('');
    expect(screen.getByLabelText('reason')).toHaveValue('');
  });

  it('holds the modal until the prefill probe settles', async () => {
    const user = userEvent.setup();
    let resolvePrefill!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolvePrefill = resolve;
    });
    const fetchMock = stubAdminFetch({ prefill: () => pending });
    renderProvider();

    await user.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(prefillCalls(fetchMock)).toHaveLength(1);
    });
    expect(screen.queryByTestId(TEST_IDS.adminOpModal)).not.toBeInTheDocument();

    await act(async () => {
      resolvePrefill(Response.json({ input: { userId: 'u-42' } }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    });
    expect(screen.getByLabelText('userId')).toHaveValue('u-42');
  });

  it('skips the prefill probe when the flow provides initial values', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAdminFetch();
    renderProvider();

    await user.click(screen.getByRole('button', { name: 'Launch seeded' }));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    });

    expect(screen.getByLabelText('userId')).toHaveValue('seed-1');
    expect(prefillCalls(fetchMock)).toHaveLength(0);
  });

  it('discards a stale prefill result after a newer flow started', async () => {
    const user = userEvent.setup();
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let served = 0;
    stubAdminFetch({
      prefill: () => {
        served += 1;
        return served === 1 ? first : Response.json({ code: 'NOT_FOUND' }, { status: 404 });
      },
    });
    renderProvider();

    await user.click(screen.getByRole('button', { name: 'Launch' }));
    fireEvent.click(screen.getByText('Launch other'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Lock account' })).toBeInTheDocument();
    });

    await act(async () => {
      resolveFirst(Response.json({ input: { userId: 'stale-value' } }));
      await Promise.resolve();
    });

    expect(screen.getByRole('heading', { name: 'Lock account' })).toBeInTheDocument();
    expect(screen.getByLabelText('userId')).toHaveValue('');
  });

  it('keeps undo-flow seeded values without firing a prefill probe', async () => {
    const user = userEvent.setup();
    const targetUserId = '5b6a4a1e-7f4f-4bfb-9d5e-0a4c1d2e3f40';
    const fetchMock = stubAdminFetch({
      execute: () =>
        Response.json({
          auditId: '01890a5c-0000-7000-8000-000000000001',
          effects: [],
          inverseInput: { userId: targetUserId, lockReason: 'admin', reason: 'undo unlock' },
        }),
    });
    renderProvider();

    await user.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText('userId'), targetUserId);
    await user.type(screen.getByLabelText('reason'), 'unlock them');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(await screen.findByTestId(TEST_IDS.adminOpExecute));
    await user.click(await screen.findByTestId(TEST_IDS.adminOpUndo));

    expect(screen.getByRole('heading', { name: 'Lock account' })).toBeInTheDocument();
    expect(screen.getByLabelText('userId')).toHaveValue(targetUserId);
    expect(screen.getByLabelText('reason')).toHaveValue('undo unlock');
    expect(prefillCalls(fetchMock)).toHaveLength(1);
  });
});

describe('useRunOp', () => {
  it('throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Launcher />)).toThrow(/OpModalProvider/);
    spy.mockRestore();
  });
});
