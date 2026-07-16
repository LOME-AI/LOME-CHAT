import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { clearRecents } from './recents.js';
import { CommandPalette } from './command-palette.js';
import { PaletteProvider } from './palette-provider.js';

const navigate = vi.fn();

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => navigate,
  };
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
  ],
};

beforeEach(() => {
  clearRecents();
  navigate.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(CATALOG)))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPalette(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <PaletteProvider>
          <CommandPalette />
        </PaletteProvider>
      </OpModalProvider>
    </QueryClientProvider>
  );
}

async function openPalette(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.keyboard('{Meta>}k{/Meta}');
  await waitFor(() => {
    expect(screen.getByTestId(TEST_IDS.adminPalette)).toBeInTheDocument();
  });
}

describe('CommandPalette', () => {
  it('opens on Cmd+K with the input focused and closes on Escape', async () => {
    const user = userEvent.setup();
    renderPalette();
    expect(screen.queryByTestId(TEST_IDS.adminPalette)).not.toBeInTheDocument();

    await openPalette(user);
    expect(screen.getByTestId(TEST_IDS.adminPaletteInput)).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.adminPalette)).not.toBeInTheDocument();
    });
  });

  it('lists the seven screens and the ops from the catalog', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);

    const palette = screen.getByTestId(TEST_IDS.adminPalette);
    await waitFor(() => {
      expect(within(palette).getByText('Credit wallet')).toBeInTheDocument();
    });
    for (const label of [
      'Dashboard',
      'Customer 360',
      'Jobs',
      'Audit trail',
      'Models',
      'SQL panel',
      'Ops catalog',
    ]) {
      expect(within(palette).getByText(label)).toBeInTheDocument();
    }
  });

  it('filters by query and shows the first match as the top result', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    await user.type(screen.getByTestId(TEST_IDS.adminPaletteInput), 'credit');

    const palette = screen.getByTestId(TEST_IDS.adminPalette);
    expect(within(palette).getByText('Top result')).toBeInTheDocument();
    expect(within(palette).getByText('Credit wallet')).toBeInTheDocument();
    expect(within(palette).queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('navigates to a screen on Enter', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    await user.type(screen.getByTestId(TEST_IDS.adminPaletteInput), 'jobs');
    await user.keyboard('{Enter}');

    expect(navigate).toHaveBeenCalledWith({ to: '/jobs' });
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.adminPalette)).not.toBeInTheDocument();
    });
  });

  it('moves the selection with arrow keys before Enter', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    const palette = screen.getByTestId(TEST_IDS.adminPalette);
    await waitFor(() => {
      expect(within(palette).getByText('Credit wallet')).toBeInTheDocument();
    });

    await user.keyboard('{ArrowDown}{Enter}');
    expect(navigate).toHaveBeenCalledWith({ to: '/customer-360' });
  });

  it('opens the OpModal when an op is selected', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    await user.type(screen.getByTestId(TEST_IDS.adminPaletteInput), 'lock account');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Lock account' })).toBeInTheDocument();
  });

  it('offers a go-to-user action that navigates to Customer 360 with the query', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    await user.type(screen.getByTestId(TEST_IDS.adminPaletteInput), 'user@example.com');

    await user.click(screen.getByText(/Go to user/));
    expect(navigate).toHaveBeenCalledWith({
      to: '/customer-360',
      search: { q: 'user@example.com' },
    });
  });

  it('moves the selection back up with ArrowUp', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    const palette = screen.getByTestId(TEST_IDS.adminPalette);
    await waitFor(() => {
      expect(within(palette).getByText('Credit wallet')).toBeInTheDocument();
    });

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}');
    expect(navigate).toHaveBeenCalledWith({ to: '/customer-360' });
  });

  it('runs an option from a keydown on the option itself', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    const palette = screen.getByTestId(TEST_IDS.adminPalette);
    await waitFor(() => {
      expect(within(palette).getByText('Credit wallet')).toBeInTheDocument();
    });

    const option = within(palette).getByText('Jobs').closest('[role="option"]');
    expect(option).not.toBeNull();
    fireEvent.keyDown(option as HTMLElement, { key: 'a' });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(option as HTMLElement, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith({ to: '/jobs' });
  });

  it('re-runs a recent entry when clicked', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    await user.type(screen.getByTestId(TEST_IDS.adminPaletteInput), 'models');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.adminPalette)).not.toBeInTheDocument();
    });
    navigate.mockReset();

    await openPalette(user);
    const palette = screen.getByTestId(TEST_IDS.adminPalette);
    const recentsSection = within(palette).getByText('Recents').closest('section');
    await user.click(within(recentsSection!).getByText('Models'));
    expect(navigate).toHaveBeenCalledWith({ to: '/models' });
  });

  it('shows a selected item under Recents on reopen', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    await user.type(screen.getByTestId(TEST_IDS.adminPaletteInput), 'jobs');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.adminPalette)).not.toBeInTheDocument();
    });

    await openPalette(user);
    const palette = screen.getByTestId(TEST_IDS.adminPalette);
    expect(within(palette).getByText('Recents')).toBeInTheDocument();
    const recentsSection = within(palette).getByText('Recents').closest('section');
    expect(recentsSection).not.toBeNull();
    expect(within(recentsSection!).getByText('Jobs')).toBeInTheDocument();
  });
});
