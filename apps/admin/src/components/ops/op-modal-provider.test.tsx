import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
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
  ],
};

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

describe('useRunOp', () => {
  it('throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Launcher />)).toThrow(/OpModalProvider/);
    spy.mockRestore();
  });
});
