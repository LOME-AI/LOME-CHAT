import { screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { requireAuth } from '@/lib/auth';
import { balanceQueryOptions } from '@/hooks/billing/billing';
import { renderRoute } from '@/test-utils/render';
import { Route } from './billing';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const { mockUseStableBalance, mockUseTransactions, mockIsPaymentDisabled } = vi.hoisted(() => ({
  mockUseStableBalance: vi.fn(),
  mockUseTransactions: vi.fn(),
  mockIsPaymentDisabled: vi.fn(() => false),
}));

// Keep the real router (createFileRoute must run for the route file); override only useNavigate.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn().mockImplementation(() => Promise.resolve()),
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: mockUseStableBalance,
}));

vi.mock('@/hooks/billing/billing', () => ({
  useTransactions: mockUseTransactions,
  balanceQueryOptions: vi.fn(() => ({ queryKey: ['balance'], queryFn: vi.fn() })),
}));

// Keep the real platform helpers (ThemeProvider's useStatusBar needs isNative);
// override only isPaymentDisabled.
vi.mock('@/capacitor/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/capacitor/platform')>();
  return {
    ...actual,
    isPaymentDisabled: mockIsPaymentDisabled,
  };
});

vi.mock('@/components/billing/manage-online-button', () => ({
  ManageOnlineButton: () => (
    <button data-testid="manage-online-button">Manage Balance Online</button>
  ),
}));

describe('BillingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('balance display', () => {
    it('displays balance with 4 decimal places', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '25.12345678',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: { transactions: [], nextCursor: null },
        isLoading: false,
      });

      renderRoute(Route);

      expect(screen.getByTestId(TEST_IDS.balanceDisplay)).toHaveTextContent('$25.1235');
    });
  });

  describe('transaction skeleton loading', () => {
    it('renders skeleton rows with matching structure when loading', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: null,
        isLoading: true,
      });

      renderRoute(Route);

      const skeletonRows = screen.getAllByTestId(TEST_IDS.transactionSkeletonRow);
      expect(skeletonRows).toHaveLength(5);

      // Each skeleton row should have two-column structure
      // Left side: two skeleton blocks (description + date)
      // Right side: two skeleton blocks (amount + balance)
      for (const row of skeletonRows) {
        const skeletonBlocks = within(row).getAllByTestId(TEST_IDS.skeletonBlock);
        expect(skeletonBlocks.length).toBe(4); // 2 left + 2 right
      }
    });

    it('skeleton rows have fixed height matching data rows', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: null,
        isLoading: true,
      });

      renderRoute(Route);

      const skeletonRows = screen.getAllByTestId(TEST_IDS.transactionSkeletonRow);

      for (const row of skeletonRows) {
        expect(row.className).toContain('h-16');
      }
    });
  });

  describe('transaction data rows', () => {
    it('renders transaction data with correct structure', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '25.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: [
            {
              id: 'tx-1',
              amount: '10.00000000',
              balanceAfter: '10.00000000',
              type: 'deposit',
              description: 'Deposit of $10.00',
              createdAt: '2024-01-01T12:00:00Z',
            },
          ],
        },
        isLoading: false,
      });

      renderRoute(Route);

      expect(screen.getByText('Deposit of $10.00')).toBeInTheDocument();
      expect(screen.getByText('+$10.00')).toBeInTheDocument();
    });
  });

  describe('fixed height container', () => {
    it('has fixed height container for transaction list when loading', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: null,
        isLoading: true,
      });

      renderRoute(Route);

      const container = screen.getByTestId(TEST_IDS.transactionListContainer);
      expect(container.className).toMatch(/h-\[/); // Should have fixed height class
    });

    it('has same fixed height container for transaction list when loaded', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: [
            {
              id: 'tx-1',
              amount: '10.00000000',
              balanceAfter: '10.00000000',
              type: 'deposit',
              description: 'Deposit of $10.00',
              createdAt: '2024-01-01T12:00:00Z',
            },
          ],
          nextCursor: null,
        },
        isLoading: false,
      });

      renderRoute(Route);

      const container = screen.getByTestId(TEST_IDS.transactionListContainer);
      expect(container.className).toMatch(/h-\[/); // Should have fixed height class
    });
  });

  describe('pagination', () => {
    it('disables next button when nextCursor is null', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: Array.from({ length: 5 }, (_, index) => ({
            id: `tx-${String(index)}`,
            amount: '10.00000000',
            balanceAfter: '10.00000000',
            type: 'deposit',
            description: `Deposit ${String(index)}`,
            createdAt: '2024-01-01T12:00:00Z',
          })),
          nextCursor: null, // No more pages
        },
        isLoading: false,
      });

      renderRoute(Route);

      const nextButton = screen.getByRole('button', { name: /next/i });
      expect(nextButton).toBeDisabled();
    });

    it('enables next button when nextCursor is present', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: Array.from({ length: 5 }, (_, index) => ({
            id: `tx-${String(index)}`,
            amount: '10.00000000',
            balanceAfter: '10.00000000',
            type: 'deposit',
            description: `Deposit ${String(index)}`,
            createdAt: '2024-01-01T12:00:00Z',
          })),
          nextCursor: '2024-01-01T00:00:00Z', // More pages available
        },
        isLoading: false,
      });

      renderRoute(Route);

      const nextButton = screen.getByRole('button', { name: /next/i });
      expect(nextButton).not.toBeDisabled();
    });
  });

  describe('platform-conditional billing', () => {
    beforeEach(() => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: { transactions: [], nextCursor: null },
        isLoading: false,
      });
    });

    it('shows Add Credits button when payments are enabled', () => {
      mockIsPaymentDisabled.mockReturnValue(false);

      renderRoute(Route);

      expect(screen.getByRole('button', { name: /add credits/i })).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.manageOnlineButton)).not.toBeInTheDocument();
    });

    it('shows Manage Balance Online button when payments are disabled', () => {
      mockIsPaymentDisabled.mockReturnValue(true);

      renderRoute(Route);

      expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /add credits/i })).not.toBeInTheDocument();
    });

    it('hides PaymentModal when payments are disabled', () => {
      mockIsPaymentDisabled.mockReturnValue(true);

      renderRoute(Route);

      expect(screen.queryByTestId(TEST_IDS.paymentModal)).not.toBeInTheDocument();
    });
  });

  describe('route data lifecycle', () => {
    it('gates the route on authentication in beforeLoad', async () => {
      const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
      expect(beforeLoad).toBeDefined();

      await beforeLoad!();

      expect(requireAuth).toHaveBeenCalledTimes(1);
    });

    it('prefetches the balance query in the loader', () => {
      const loader = Route.options.loader as
        | ((args: {
            context: { queryClient: { prefetchQuery: ReturnType<typeof vi.fn> } };
          }) => void)
        | undefined;
      expect(loader).toBeDefined();
      const prefetchQuery = vi.fn();

      loader!({ context: { queryClient: { prefetchQuery } } });

      expect(balanceQueryOptions).toHaveBeenCalledTimes(1);
      expect(prefetchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['balance'] })
      );
    });
  });
});
