import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BudgetMessages } from '@/components/chat/budget/budget-messages';
import type { BudgetError } from '@hushbox/shared';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className} data-testid="budget-link">
      {children}
    </a>
  ),
}));

describe('BudgetMessages', () => {
  describe('rendering', () => {
    it('renders no visible content when errors array is empty', () => {
      render(<BudgetMessages errors={[]} />);
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
    });

    it('renders single error message', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test error message' }];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByText('Test error message')).toBeInTheDocument();
    });

    it('renders multiple error messages', () => {
      const errors: BudgetError[] = [
        { id: 'error1', type: 'error', message: 'First error' },
        { id: 'error2', type: 'warning', message: 'Second warning' },
        { id: 'info1', type: 'info', message: 'Info message' },
      ];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByText('First error')).toBeInTheDocument();
      expect(screen.getByText('Second warning')).toBeInTheDocument();
      expect(screen.getByText('Info message')).toBeInTheDocument();
    });

    it('renders container with testid', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test' }];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByTestId('budget-messages')).toBeInTheDocument();
    });
  });

  describe('accessible styling (neutral bg + colored border + colored icon)', () => {
    it('all message types have neutral background and neutral text', () => {
      const errors: BudgetError[] = [
        { id: 'error1', type: 'error', message: 'Error' },
        { id: 'warn1', type: 'warning', message: 'Warning' },
        { id: 'info1', type: 'info', message: 'Info' },
      ];
      render(<BudgetMessages errors={errors} />);

      const errorMsg = screen.getByTestId('budget-message-error1');
      const warnMsg = screen.getByTestId('budget-message-warn1');
      const infoMsg = screen.getByTestId('budget-message-info1');

      expect(errorMsg).toHaveClass('bg-muted/50');
      expect(warnMsg).toHaveClass('bg-muted/50');
      expect(infoMsg).toHaveClass('bg-muted/50');

      expect(errorMsg).toHaveClass('text-foreground');
      expect(warnMsg).toHaveClass('text-foreground');
      expect(infoMsg).toHaveClass('text-foreground');
    });

    it('error type has red left border', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Error message' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveClass('border-l-3');
      expect(message).toHaveClass('border-l-destructive');
    });

    it('warning type has yellow left border', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'warning', message: 'Warning message' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveClass('border-l-3');
      expect(message).toHaveClass('border-l-yellow-500');
    });

    it('info type has blue left border', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'info', message: 'Info message' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveClass('border-l-3');
      expect(message).toHaveClass('border-l-blue-500');
    });

    it('error icon has red color', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Error' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toHaveClass('text-destructive');
    });

    it('warning icon has yellow color', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'warning', message: 'Warning' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toHaveClass('text-yellow-500');
    });

    it('info icon has blue color', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'info', message: 'Info' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toHaveClass('text-blue-500');
    });
  });

  describe('icons', () => {
    it('shows AlertTriangle icon for error type', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Error message' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toBeInTheDocument();
    });

    it('shows AlertTriangle icon for warning type', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'warning', message: 'Warning message' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toBeInTheDocument();
    });

    it('shows Info icon for info type', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'info', message: 'Info message' }];
      render(<BudgetMessages errors={errors} />);

      const icon = screen.getByTestId('budget-message-icon-test');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('layout', () => {
    it('stacks messages vertically with gap', () => {
      const errors: BudgetError[] = [
        { id: 'error1', type: 'error', message: 'First' },
        { id: 'error2', type: 'warning', message: 'Second' },
      ];
      render(<BudgetMessages errors={errors} />);

      const container = screen.getByTestId('budget-messages');
      expect(container).toHaveClass('flex');
      expect(container).toHaveClass('flex-col');
      expect(container).toHaveClass('gap-2');
    });

    it('message has flex layout with icon and text', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveClass('flex');
      expect(message).toHaveClass('items-center');
      expect(message).toHaveClass('gap-2');
    });

    it('message has rounded corners and padding', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveClass('rounded');
      expect(message).toHaveClass('px-3');
      expect(message).toHaveClass('py-2');
    });
  });

  describe('accessibility', () => {
    it('uses appropriate role for alerts', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Error' }];
      render(<BudgetMessages errors={errors} />);

      const message = screen.getByTestId('budget-message-test');
      expect(message).toHaveAttribute('role', 'alert');
    });
  });

  describe('custom className', () => {
    it('accepts custom className on container', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test' }];
      render(<BudgetMessages errors={errors} className="custom-class" />);

      const container = screen.getByTestId('budget-messages');
      expect(container).toHaveClass('custom-class');
    });
  });

  describe('animation', () => {
    it('removes all messages when errors becomes empty', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'error', message: 'Test' }];
      const { rerender } = render(<BudgetMessages errors={errors} />);

      expect(screen.getByTestId('budget-message-test')).toBeInTheDocument();

      rerender(<BudgetMessages errors={[]} />);

      expect(screen.queryByTestId('budget-message-test')).not.toBeInTheDocument();
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
    });

    it('animates individual messages when list changes', () => {
      const initialErrors: BudgetError[] = [{ id: 'first', type: 'error', message: 'First' }];
      const { rerender } = render(<BudgetMessages errors={initialErrors} />);

      expect(screen.getByTestId('budget-message-first')).toBeInTheDocument();

      const updatedErrors: BudgetError[] = [
        { id: 'first', type: 'error', message: 'First' },
        { id: 'second', type: 'warning', message: 'Second' },
      ];
      rerender(<BudgetMessages errors={updatedErrors} />);

      expect(screen.getByTestId('budget-message-first')).toBeInTheDocument();
      expect(screen.getByTestId('budget-message-second')).toBeInTheDocument();
    });

    it('wraps each individual message in overflow-hidden container for height animation', () => {
      const errors: BudgetError[] = [
        { id: 'first', type: 'error', message: 'First' },
        { id: 'second', type: 'warning', message: 'Second' },
      ];
      render(<BudgetMessages errors={errors} />);

      const firstMessage = screen.getByTestId('budget-message-first');
      const secondMessage = screen.getByTestId('budget-message-second');

      // Each message should have an overflow-hidden parent wrapper for height animation
      expect(firstMessage.parentElement).toHaveClass('overflow-hidden');
      expect(secondMessage.parentElement).toHaveClass('overflow-hidden');
    });

    it('animates individual message removal while keeping others visible', async () => {
      const initialErrors: BudgetError[] = [
        { id: 'first', type: 'error', message: 'First' },
        { id: 'second', type: 'warning', message: 'Second' },
      ];
      const { rerender } = render(<BudgetMessages errors={initialErrors} />);

      expect(screen.getByTestId('budget-message-first')).toBeInTheDocument();
      expect(screen.getByTestId('budget-message-second')).toBeInTheDocument();

      const updatedErrors: BudgetError[] = [{ id: 'first', type: 'error', message: 'First' }];
      rerender(<BudgetMessages errors={updatedErrors} />);

      expect(screen.getByTestId('budget-message-first')).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.queryByTestId('budget-message-second')).not.toBeInTheDocument();
      });
    });
  });

  describe('link rendering', () => {
    it('renders plain message when no segments provided', () => {
      const errors: BudgetError[] = [{ id: 'test', type: 'info', message: 'Plain message' }];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByText('Plain message')).toBeInTheDocument();
      expect(screen.queryByTestId('budget-link')).not.toBeInTheDocument();
    });

    it('renders plain message when segments is empty array', () => {
      const errors: BudgetError[] = [
        { id: 'test', type: 'info', message: 'Plain message', segments: [] },
      ];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByText('Plain message')).toBeInTheDocument();
      expect(screen.queryByTestId('budget-link')).not.toBeInTheDocument();
    });

    it('renders clickable link when segment has link property', () => {
      const errors: BudgetError[] = [
        {
          id: 'test',
          type: 'info',
          message: 'Sample info. Sign up for details.',
          segments: [
            { text: 'Sample info. ' },
            { text: 'Sign up', link: '/signup' },
            { text: ' for details.' },
          ],
        },
      ];
      render(<BudgetMessages errors={errors} />);

      const link = screen.getByTestId('budget-link');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/signup');
      expect(link).toHaveTextContent('Sign up');
    });

    it('renders link with primary styling', () => {
      const errors: BudgetError[] = [
        {
          id: 'test',
          type: 'info',
          message: 'Sample warning. Top up for details.',
          segments: [
            { text: 'Sample warning. ' },
            { text: 'Top up', link: '/billing' },
            { text: ' for details.' },
          ],
        },
      ];
      render(<BudgetMessages errors={errors} />);

      const link = screen.getByTestId('budget-link');
      expect(link).toHaveClass('text-primary');
      expect(link).toHaveClass('hover:underline');
    });

    it('renders all text segments correctly', () => {
      const errors: BudgetError[] = [
        {
          id: 'test',
          type: 'error',
          message: 'Sample error. Top up for details.',
          segments: [
            { text: 'Sample error. ' },
            { text: 'Top up', link: '/billing' },
            { text: ' for details.' },
          ],
        },
      ];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByText(/Sample error\./)).toBeInTheDocument();
      expect(screen.getByText('Top up')).toBeInTheDocument();
      expect(screen.getByText(/for details\./)).toBeInTheDocument();
    });

    it('renders billing link correctly', () => {
      const errors: BudgetError[] = [
        {
          id: 'test',
          type: 'info',
          message: 'Sample warning. Top up for details.',
          segments: [
            { text: 'Sample warning. ' },
            { text: 'Top up', link: '/billing' },
            { text: ' for details.' },
          ],
        },
      ];
      render(<BudgetMessages errors={errors} />);

      const link = screen.getByRole('link', { name: 'Top up' });
      expect(link).toHaveAttribute('href', '/billing');
    });

    it('renders signup link correctly', () => {
      const errors: BudgetError[] = [
        {
          id: 'test',
          type: 'info',
          message: 'Sample info. Sign up for details.',
          segments: [
            { text: 'Sample info. ' },
            { text: 'Sign up', link: '/signup' },
            { text: ' for details.' },
          ],
        },
      ];
      render(<BudgetMessages errors={errors} />);

      const link = screen.getByRole('link', { name: 'Sign up' });
      expect(link).toHaveAttribute('href', '/signup');
    });
  });

  describe('dismiss', () => {
    it('does not show dismiss button for error type', () => {
      const errors: BudgetError[] = [{ id: 'err', type: 'error', message: 'Error' }];
      render(<BudgetMessages errors={errors} />);

      expect(screen.queryByTestId('budget-dismiss-err')).not.toBeInTheDocument();
    });

    it('shows dismiss button for warning type', () => {
      const errors: BudgetError[] = [{ id: 'warn', type: 'warning', message: 'Warning' }];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByTestId('budget-dismiss-warn')).toBeInTheDocument();
    });

    it('shows dismiss button for info type', () => {
      const errors: BudgetError[] = [{ id: 'info', type: 'info', message: 'Info' }];
      render(<BudgetMessages errors={errors} />);

      expect(screen.getByTestId('budget-dismiss-info')).toBeInTheDocument();
    });

    it('hides warning message when dismiss is clicked', async () => {
      const user = userEvent.setup();
      const errors: BudgetError[] = [{ id: 'warn', type: 'warning', message: 'Warning' }];
      render(<BudgetMessages errors={errors} />);

      await user.click(screen.getByTestId('budget-dismiss-warn'));

      await waitFor(() => {
        expect(screen.queryByTestId('budget-message-warn')).not.toBeInTheDocument();
      });
    });

    it('hides info message when dismiss is clicked', async () => {
      const user = userEvent.setup();
      const errors: BudgetError[] = [{ id: 'info', type: 'info', message: 'Info' }];
      render(<BudgetMessages errors={errors} />);

      await user.click(screen.getByTestId('budget-dismiss-info'));

      await waitFor(() => {
        expect(screen.queryByTestId('budget-message-info')).not.toBeInTheDocument();
      });
    });

    it('reappears after condition cycles off then on', async () => {
      const user = userEvent.setup();
      const errors: BudgetError[] = [
        { id: 'answer_may_be_shortened', type: 'warning', message: 'Low' },
      ];
      const { rerender } = render(<BudgetMessages errors={errors} />);

      await user.click(screen.getByTestId('budget-dismiss-answer_may_be_shortened'));
      await waitFor(() => {
        expect(
          screen.queryByTestId('budget-message-answer_may_be_shortened')
        ).not.toBeInTheDocument();
      });

      rerender(<BudgetMessages errors={[]} />);

      rerender(<BudgetMessages errors={errors} />);

      expect(screen.getByTestId('budget-message-answer_may_be_shortened')).toBeInTheDocument();
    });

    it('dismissing one message does not hide others', async () => {
      const user = userEvent.setup();
      const errors: BudgetError[] = [
        { id: 'w1', type: 'warning', message: 'W1' },
        { id: 'w2', type: 'warning', message: 'W2' },
      ];
      render(<BudgetMessages errors={errors} />);

      await user.click(screen.getByTestId('budget-dismiss-w1'));
      await waitFor(() => {
        expect(screen.queryByTestId('budget-message-w1')).not.toBeInTheDocument();
      });

      expect(screen.getByTestId('budget-message-w2')).toBeInTheDocument();
    });

    it('error stays visible when warning is dismissed', async () => {
      const user = userEvent.setup();
      const errors: BudgetError[] = [
        { id: 'err', type: 'error', message: 'Error' },
        { id: 'warn', type: 'warning', message: 'Warning' },
      ];
      render(<BudgetMessages errors={errors} />);

      await user.click(screen.getByTestId('budget-dismiss-warn'));
      await waitFor(() => {
        expect(screen.queryByTestId('budget-message-warn')).not.toBeInTheDocument();
      });

      expect(screen.getByTestId('budget-message-err')).toBeInTheDocument();
    });

    it('dismiss button has accessible aria-label', () => {
      const errors: BudgetError[] = [{ id: 'warn', type: 'warning', message: 'Warning' }];
      render(<BudgetMessages errors={errors} />);

      const button = screen.getByTestId('budget-dismiss-warn');
      expect(button).toHaveAttribute('aria-label', 'Dismiss notification');
    });

    it('dismiss button icon is aria-hidden', () => {
      const errors: BudgetError[] = [{ id: 'warn', type: 'warning', message: 'Warning' }];
      render(<BudgetMessages errors={errors} />);

      const button = screen.getByTestId('budget-dismiss-warn');
      const icon = button.querySelector('svg');
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
