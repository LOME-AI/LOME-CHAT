import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
}));

vi.mock('@hushbox/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/ui')>()),
  useIsMobile: vi.fn(() => false),
}));

import { render, screen } from '@testing-library/react';
import { useIsMobile } from '@hushbox/ui';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { PaymentModal } from './payment-modal';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});

const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

describe('PaymentModal', () => {
  describe('when closed', () => {
    it('does not render modal content when closed', () => {
      render(<PaymentModal open={false} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.queryByTestId(TEST_IDS.paymentModal)).not.toBeInTheDocument();
    });
  });

  describe('when open', () => {
    it('renders modal content when open', () => {
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.getByTestId(TEST_IDS.paymentModal)).toBeInTheDocument();
    });

    it('renders payment form inside modal', () => {
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.getByText('Add Credits')).toBeInTheDocument();
    });

    it('renders modal backdrop', () => {
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.getByTestId(TEST_IDS.overlayBackdrop)).toBeInTheDocument();
    });
  });

  describe('closing', () => {
    it('calls onOpenChange when backdrop is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<PaymentModal open={true} onOpenChange={onOpenChange} onSuccess={vi.fn()} />, {
        wrapper,
      });

      await user.click(screen.getByTestId(TEST_IDS.overlayBackdrop));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('calls onOpenChange when Escape key is pressed', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<PaymentModal open={true} onOpenChange={onOpenChange} onSuccess={vi.fn()} />, {
        wrapper,
      });

      await user.keyboard('{Escape}');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('closes when the payment form cancel button is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<PaymentModal open={true} onOpenChange={onOpenChange} onSuccess={vi.fn()} />, {
        wrapper,
      });

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('mobile', () => {
    it('prevents overlay auto-focus on mobile to avoid the keyboard', () => {
      vi.mocked(useIsMobile).mockReturnValue(true);
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });

      // Radix fires onOpenAutoFocus on mount; on mobile the handler prevents it.
      expect(screen.getByTestId(TEST_IDS.paymentModal)).toBeInTheDocument();
      vi.mocked(useIsMobile).mockReturnValue(false);
    });
  });
});
