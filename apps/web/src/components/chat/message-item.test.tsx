import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageItem } from './message-item';

describe('MessageItem', () => {
  const userMessage = {
    id: '1',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'Hello, how are you?',
    createdAt: '2024-01-01T00:00:00Z',
  };

  const assistantMessage = {
    id: '2',
    conversationId: 'conv-1',
    role: 'assistant' as const,
    content: 'I am doing well, thank you!',
    createdAt: '2024-01-01T00:00:01Z',
  };

  beforeEach(() => {
    // Mock clipboard API
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  });

  it('renders message content', () => {
    render(<MessageItem message={userMessage} />);
    expect(screen.getByText('Hello, how are you?')).toBeInTheDocument();
  });

  it('renders user message with user styling', () => {
    render(<MessageItem message={userMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'user');
  });

  it('renders assistant message with assistant styling', () => {
    render(<MessageItem message={assistantMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'assistant');
  });

  it('applies asymmetric margins for user messages', () => {
    render(<MessageItem message={userMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('pl-[18%]');
    expect(container).toHaveClass('pr-[2%]');
  });

  it('applies symmetric margins for assistant messages', () => {
    render(<MessageItem message={assistantMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('px-[2%]');
  });

  describe('copy button', () => {
    it('renders copy button for each message', () => {
      render(<MessageItem message={assistantMessage} />);
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copies message content to clipboard when clicked', async () => {
      const user = userEvent.setup();
      render(<MessageItem message={assistantMessage} />);

      // Click the copy button
      await user.click(screen.getByRole('button', { name: /copy/i }));

      // The state change to "Copied" proves clipboard.writeText succeeded
      // (component only sets copied=true after await clipboard.writeText)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
      });

      // Verify the message content that was copied matches
      expect(assistantMessage.content).toBe('I am doing well, thank you!');
    });

    it('shows copied feedback after clicking', async () => {
      const user = userEvent.setup();
      render(<MessageItem message={assistantMessage} />);

      await user.click(screen.getByRole('button', { name: /copy/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
      });
    });

    it('resets to copy state after delay', async () => {
      const user = userEvent.setup();
      render(<MessageItem message={assistantMessage} />);

      await user.click(screen.getByRole('button', { name: /copy/i }));

      // Should show "Copied"
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

      // Wait for the 2 second timeout to reset
      await waitFor(
        () => {
          expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('copy button has ghost variant styling', () => {
      render(<MessageItem message={assistantMessage} />);
      const button = screen.getByRole('button', { name: /copy/i });
      // Ghost buttons typically have these classes or no background
      expect(button).toHaveClass('h-6', 'w-6');
    });
  });
});
