import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LegacyModality } from '@hushbox/shared';
import { MessageInput } from '@/components/chat/input/message-input';

const activeModalityRef = { current: 'text' as LegacyModality };

vi.mock('@/stores/model', () => ({
  useModelStore: <T,>(selector: (state: { activeModality: LegacyModality }) => T): T =>
    selector({ activeModality: activeModalityRef.current }),
}));

describe('MessageInput', () => {
  const mockOnSend = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    activeModalityRef.current = 'text';
  });

  it('renders textarea', () => {
    render(<MessageInput onSend={mockOnSend} />);
    expect(screen.getByPlaceholderText(/message/i)).toBeInTheDocument();
  });

  it('renders send button', () => {
    render(<MessageInput onSend={mockOnSend} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('calls onSend with message when send button clicked', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={mockOnSend} />);

    const textarea = screen.getByPlaceholderText(/message/i);
    await user.type(textarea, 'Hello AI');
    await user.click(screen.getByRole('button', { name: /send/i }));

    expect(mockOnSend).toHaveBeenCalledWith('Hello AI');
  });

  it('clears textarea after sending', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={mockOnSend} />);

    const textarea = screen.getByPlaceholderText(/message/i);
    await user.type(textarea, 'Hello AI');
    await user.click(screen.getByRole('button', { name: /send/i }));

    expect(textarea).toHaveValue('');
  });

  it('disables send button when textarea is empty', () => {
    render(<MessageInput onSend={mockOnSend} />);
    const sendButton = screen.getByRole('button', { name: /send/i });
    expect(sendButton).toBeDisabled();
  });

  it('enables send button when textarea has content', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={mockOnSend} />);

    const textarea = screen.getByPlaceholderText(/message/i);
    await user.type(textarea, 'Hello');

    const sendButton = screen.getByRole('button', { name: /send/i });
    expect(sendButton).not.toBeDisabled();
  });

  it('sends message on Enter key (without Shift)', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={mockOnSend} />);

    const textarea = screen.getByPlaceholderText(/message/i);
    await user.type(textarea, 'Hello AI{Enter}');

    expect(mockOnSend).toHaveBeenCalledWith('Hello AI');
  });

  it('does not send on Shift+Enter (allows newline)', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={mockOnSend} />);

    const textarea = screen.getByPlaceholderText(/message/i);
    await user.type(textarea, 'Hello{Shift>}{Enter}{/Shift}World');

    expect(mockOnSend).not.toHaveBeenCalled();
  });

  it('shows disabled state when disabled prop is true', () => {
    render(<MessageInput onSend={mockOnSend} disabled />);
    const textarea = screen.getByPlaceholderText(/message/i);
    expect(textarea).toBeDisabled();
  });

  describe('streaming mode', () => {
    const mockOnStop = vi.fn();

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('shows stop button instead of send button when streaming', () => {
      render(<MessageInput onSend={mockOnSend} isStreaming onStop={mockOnStop} />);

      expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
    });

    it('calls onStop when stop button is clicked', async () => {
      const user = userEvent.setup();
      render(<MessageInput onSend={mockOnSend} isStreaming onStop={mockOnStop} />);

      await user.click(screen.getByRole('button', { name: /stop/i }));

      expect(mockOnStop).toHaveBeenCalled();
    });

    it('disables textarea while streaming', () => {
      render(<MessageInput onSend={mockOnSend} isStreaming onStop={mockOnStop} />);

      const textarea = screen.getByPlaceholderText(/message/i);
      expect(textarea).toBeDisabled();
    });

    it('shows send button when not streaming', () => {
      render(<MessageInput onSend={mockOnSend} isStreaming={false} onStop={mockOnStop} />);

      expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
    });

    it('stop button is always enabled during streaming', () => {
      render(<MessageInput onSend={mockOnSend} isStreaming onStop={mockOnStop} />);

      const stopButton = screen.getByRole('button', { name: /stop/i });
      expect(stopButton).not.toBeDisabled();
    });
  });

  describe('modality-aware copy', () => {
    it('uses text placeholder when modality is text', () => {
      activeModalityRef.current = 'text';
      render(<MessageInput onSend={mockOnSend} />);
      expect(screen.getByPlaceholderText('Type a message...')).toBeInTheDocument();
    });

    it('uses image placeholder when modality is image', () => {
      activeModalityRef.current = 'image';
      render(<MessageInput onSend={mockOnSend} />);
      expect(screen.getByPlaceholderText('Describe the image you want...')).toBeInTheDocument();
    });

    it('uses video placeholder when modality is video', () => {
      activeModalityRef.current = 'video';
      render(<MessageInput onSend={mockOnSend} />);
      expect(screen.getByPlaceholderText('Describe the video you want...')).toBeInTheDocument();
    });

    it('uses audio placeholder when modality is audio', () => {
      activeModalityRef.current = 'audio';
      render(<MessageInput onSend={mockOnSend} />);
      expect(screen.getByPlaceholderText('Describe the audio you want...')).toBeInTheDocument();
    });

    it('uses "Send message" aria-label when modality is text', () => {
      activeModalityRef.current = 'text';
      render(<MessageInput onSend={mockOnSend} />);
      expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
    });

    it('uses "Generate image" aria-label when modality is image', () => {
      activeModalityRef.current = 'image';
      render(<MessageInput onSend={mockOnSend} />);
      expect(screen.getByRole('button', { name: 'Generate image' })).toBeInTheDocument();
    });

    it('uses "Generate video" aria-label when modality is video', () => {
      activeModalityRef.current = 'video';
      render(<MessageInput onSend={mockOnSend} />);
      expect(screen.getByRole('button', { name: 'Generate video' })).toBeInTheDocument();
    });

    it('uses "Generate audio" aria-label when modality is audio', () => {
      activeModalityRef.current = 'audio';
      render(<MessageInput onSend={mockOnSend} />);
      expect(screen.getByRole('button', { name: 'Generate audio' })).toBeInTheDocument();
    });
  });
});
