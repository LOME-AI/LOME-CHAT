import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromptInput } from './prompt-input';

describe('PromptInput', () => {
  const mockOnChange = vi.fn();
  const mockOnSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a textarea', () => {
    render(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('displays placeholder text', () => {
    render(
      <PromptInput
        value=""
        onChange={mockOnChange}
        onSubmit={mockOnSubmit}
        placeholder="Ask me anything..."
      />
    );
    expect(screen.getByPlaceholderText('Ask me anything...')).toBeInTheDocument();
  });

  it('displays the current value', () => {
    render(<PromptInput value="Hello world" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('textbox')).toHaveValue('Hello world');
  });

  it('calls onChange when typing', async () => {
    const user = userEvent.setup();
    render(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Test');
    expect(mockOnChange).toHaveBeenCalled();
  });

  it('calls onSubmit when Enter is pressed without Shift', () => {
    render(<PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(mockOnSubmit).toHaveBeenCalled();
  });

  it('does not call onSubmit when Shift+Enter is pressed (allows newline)', () => {
    render(<PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('has send button', () => {
    render(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('send button calls onSubmit when clicked', async () => {
    const user = userEvent.setup();
    render(<PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const sendButton = screen.getByRole('button', { name: /send/i });
    await user.click(sendButton);
    expect(mockOnSubmit).toHaveBeenCalled();
  });

  it('send button is disabled when value is empty', () => {
    render(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  describe('token counter', () => {
    it('displays token counter with current/max format', () => {
      // "Hello" = 5 chars ≈ 2 tokens (5/4 rounded up)
      render(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          maxTokens={2000}
        />
      );
      expect(screen.getByTestId('token-counter')).toHaveTextContent('2/2000');
    });

    it('shows over-limit format when exceeding maxTokens', () => {
      // 8000+ chars = 2000+ tokens
      const longText = 'a'.repeat(8020); // ~2005 tokens
      render(
        <PromptInput
          value={longText}
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          maxTokens={2000}
        />
      );
      // Should show format like "2000+5/2000"
      expect(screen.getByTestId('token-counter')).toHaveTextContent(/2000\+\d+\/2000/);
    });

    it('shows warning message when over token limit', () => {
      const longText = 'a'.repeat(8020); // ~2005 tokens
      render(
        <PromptInput
          value={longText}
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          maxTokens={2000}
        />
      );
      expect(
        screen.getByText(/tokens beyond the 2000 token limit will not be included/i)
      ).toBeInTheDocument();
    });

    it('send button is disabled when over token limit', () => {
      const longText = 'a'.repeat(8020); // ~2005 tokens
      render(
        <PromptInput
          value={longText}
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          maxTokens={2000}
        />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('uses default maxTokens of 2000 when not provided', () => {
      render(<PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      expect(screen.getByTestId('token-counter')).toHaveTextContent('2/2000');
    });

    it('token counter has aria-live for screen reader announcements', () => {
      render(<PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const counter = screen.getByTestId('token-counter');
      expect(counter).toHaveAttribute('aria-live', 'polite');
    });

    it('token counter has aria-atomic for complete announcements', () => {
      render(<PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const counter = screen.getByTestId('token-counter');
      expect(counter).toHaveAttribute('aria-atomic', 'true');
    });
  });

  describe('streaming mode', () => {
    const mockOnStop = vi.fn();

    beforeEach(() => {
      mockOnStop.mockClear();
    });

    it('shows stop button instead of send button when streaming', () => {
      render(
        <PromptInput
          value="Test"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isStreaming
          onStop={mockOnStop}
        />
      );
      expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
    });

    it('calls onStop when stop button is clicked', async () => {
      const user = userEvent.setup();
      render(
        <PromptInput
          value="Test"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isStreaming
          onStop={mockOnStop}
        />
      );
      await user.click(screen.getByRole('button', { name: /stop/i }));
      expect(mockOnStop).toHaveBeenCalled();
    });

    it('disables textarea while streaming', () => {
      render(
        <PromptInput
          value="Test"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isStreaming
          onStop={mockOnStop}
        />
      );
      expect(screen.getByRole('textbox')).toBeDisabled();
    });
  });
});
