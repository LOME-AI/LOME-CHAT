import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import type { BalanceTransactionResponse } from '@hushbox/shared';

const { mockUseStableBalance, mockUseTransactions, mockRefetchBalance, mockIsPaymentDisabled } =
  vi.hoisted(() => ({
    mockUseStableBalance: vi.fn(),
    mockUseTransactions: vi.fn(),
    mockRefetchBalance: vi.fn(),
    mockIsPaymentDisabled: vi.fn(() => false),
  }));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: (...args: unknown[]) => mockUseStableBalance(...args),
}));

vi.mock('@/hooks/billing/billing', () => ({
  useTransactions: (...args: unknown[]) => mockUseTransactions(...args),
}));

vi.mock('@/capacitor/platform', () => ({
  isPaymentDisabled: () => mockIsPaymentDisabled(),
}));

// Stub the payment modal so opening it never boots the HelcimPay.js flow; the
// stub also lets us fire its onSuccess to verify the balance refetch wiring.
vi.mock('@/components/billing/payment-modal', () => ({
  PaymentModal: ({
    open,
    onSuccess,
  }: {
    open: boolean;
    onSuccess: () => void;
  }): React.JSX.Element | null =>
    open ? (
      <div data-testid="payment-modal-stub">
        <button type="button" onClick={onSuccess}>
          stub-success
        </button>
      </div>
    ) : null,
}));

import { BillingContent } from './billing-content';

function tx(overrides: Record<string, unknown>): BalanceTransactionResponse {
  return {
    id: Math.random().toString(36).slice(2),
    type: 'deposit',
    amount: '10.00',
    balanceAfter: '100000000000',
    createdAt: '2025-01-01T12:00:00Z',
    ...overrides,
  } as unknown as BalanceTransactionResponse;
}

function setTransactions(
  transactions: BalanceTransactionResponse[],
  extra?: { isLoading?: boolean; nextCursor?: string | null }
): void {
  mockUseTransactions.mockReturnValue({
    data: { transactions, nextCursor: extra?.nextCursor ?? null },
    isLoading: extra?.isLoading ?? false,
  });
}

describe('BillingContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPaymentDisabled.mockReturnValue(false);
    mockUseStableBalance.mockReturnValue({
      displayBalance: '25.5',
      isStable: true,
      refetch: mockRefetchBalance,
    });
    setTransactions([tx({ type: 'deposit', amount: '20.00' })], { nextCursor: null });
  });

  describe('balance card', () => {
    it('shows the formatted balance when stable', () => {
      render(<BillingContent />);
      expect(screen.getByTestId(TEST_IDS.balanceDisplay)).toBeInTheDocument();
    });

    it('shows a skeleton when the balance is not stable', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '0',
        isStable: false,
        refetch: mockRefetchBalance,
      });
      render(<BillingContent />);
      expect(screen.queryByTestId(TEST_IDS.balanceDisplay)).not.toBeInTheDocument();
    });

    it('shows Add Credits when payments are enabled', () => {
      render(<BillingContent />);
      expect(screen.getByRole('button', { name: /add credits/i })).toBeInTheDocument();
    });

    it('shows the manage-online button when payments are disabled and omits the modal', () => {
      mockIsPaymentDisabled.mockReturnValue(true);
      render(<BillingContent />);
      expect(screen.queryByRole('button', { name: /add credits/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId('payment-modal-stub')).not.toBeInTheDocument();
    });
  });

  describe('payment modal', () => {
    it('opens the payment modal when Add Credits is clicked', async () => {
      const user = userEvent.setup();
      render(<BillingContent />);

      expect(screen.queryByTestId('payment-modal-stub')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /add credits/i }));

      expect(screen.getByTestId('payment-modal-stub')).toBeInTheDocument();
    });

    it('refetches the balance after a successful payment', async () => {
      const user = userEvent.setup();
      render(<BillingContent />);

      await user.click(screen.getByRole('button', { name: /add credits/i }));
      await user.click(screen.getByText('stub-success'));

      expect(mockRefetchBalance).toHaveBeenCalled();
    });
  });

  describe('transaction list', () => {
    it('renders skeleton rows while loading', () => {
      setTransactions([], { isLoading: true });
      render(<BillingContent />);
      expect(screen.getAllByTestId(TEST_IDS.transactionSkeletonRow).length).toBeGreaterThan(0);
    });

    it('shows an empty state when there are no purchases on the first page', () => {
      setTransactions([]);
      render(<BillingContent />);
      expect(screen.getByText('No purchases yet')).toBeInTheDocument();
    });

    it('handles undefined transaction data', () => {
      // Exercises the `transactionsData?.transactions ?? []` fallback.
      mockUseTransactions.mockReturnValue({ data: undefined, isLoading: false });
      render(<BillingContent />);
      expect(screen.getByText('No purchases yet')).toBeInTheDocument();
    });

    it('renders labels for every transaction type', () => {
      setTransactions([
        tx({
          type: 'usage_charge',
          model: 'gpt-4',
          inputCharacters: 100,
          outputCharacters: 50,
          deductionSource: 'freeAllowance',
        }),
        tx({ type: 'usage_charge', model: undefined, deductionSource: 'balance' }),
        tx({ type: 'deposit', amount: '15.00' }),
        tx({ type: 'refund', amount: '5.00' }),
        tx({ type: 'adjustment' }),
        tx({ type: 'mystery_type' }),
      ]);
      render(<BillingContent />);

      expect(
        screen.getByText(/AI response: gpt-4 \(150 chars\) \(free allowance\)/)
      ).toBeInTheDocument();
      expect(screen.getByText(/AI response: unknown \(0 chars\)/)).toBeInTheDocument();
      expect(screen.getByText('Deposit of $15.00')).toBeInTheDocument();
      expect(screen.getByText('Refund of $5.00')).toBeInTheDocument();
      expect(screen.getByText('Balance adjustment')).toBeInTheDocument();
      expect(screen.getByText('mystery_type')).toBeInTheDocument();
    });
  });

  describe('pagination', () => {
    it('disables Previous on the first page and enables Next when more pages exist', () => {
      setTransactions([tx({ type: 'deposit' })], { nextCursor: 'cursor-2' });
      render(<BillingContent />);

      expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();
    });

    it('advances to the next page and re-queries with the new offset', async () => {
      const user = userEvent.setup();
      setTransactions([tx({ type: 'deposit' })], { nextCursor: 'cursor-2' });
      render(<BillingContent />);

      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByText('Page 2')).toBeInTheDocument();
      expect(mockUseTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 5, type: 'deposit' })
      );
    });

    it('goes back to the previous page', async () => {
      const user = userEvent.setup();
      setTransactions([tx({ type: 'deposit' })], { nextCursor: 'cursor-2' });
      render(<BillingContent />);

      await user.click(screen.getByRole('button', { name: /next/i }));
      expect(screen.getByText('Page 2')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /previous/i }));
      expect(screen.getByText('Page 1')).toBeInTheDocument();
    });
  });

  describe('billing-only mode', () => {
    it('requests the balance with enabled when billingOnly is set', () => {
      render(<BillingContent billingOnly={true} />);
      expect(mockUseStableBalance).toHaveBeenCalledWith({ enabled: true });
    });
  });
});
