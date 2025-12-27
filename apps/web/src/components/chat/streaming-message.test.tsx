import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StreamingMessage } from './streaming-message';

describe('StreamingMessage', () => {
  it('renders the streaming content', () => {
    render(<StreamingMessage content="Hello, I am responding..." />);

    expect(screen.getByText('Hello, I am responding...')).toBeInTheDocument();
  });

  it('shows loading indicator when streaming', () => {
    render(<StreamingMessage content="Partial response" isStreaming />);

    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
  });

  it('hides loading indicator when not streaming', () => {
    render(<StreamingMessage content="Complete response" isStreaming={false} />);

    expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument();
  });

  it('renders with no bubble styling (transparent background)', () => {
    render(<StreamingMessage content="Test" />);

    const container = screen.getByTestId('streaming-message');
    expect(container).toHaveClass('text-foreground');
    // Should not have any bg-* class for transparent appearance
    expect(container.className).not.toMatch(/bg-/);
  });

  it('applies symmetric margins for AI messages', () => {
    render(<StreamingMessage content="Test" />);

    const container = screen.getByTestId('streaming-message-container');
    expect(container).toHaveClass('px-[2%]');
  });

  it('applies custom className', () => {
    render(<StreamingMessage content="Test" className="custom-class" />);

    expect(screen.getByTestId('streaming-message-container')).toHaveClass('custom-class');
  });

  it('renders empty content gracefully', () => {
    render(<StreamingMessage content="" isStreaming />);

    expect(screen.getByTestId('streaming-message')).toBeInTheDocument();
    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
  });

  it('preserves whitespace in content', () => {
    render(<StreamingMessage content="Line 1\nLine 2" />);

    // The content paragraph inside the message has whitespace-pre-wrap
    const content = screen.getByText(/Line 1/);
    expect(content).toHaveClass('whitespace-pre-wrap');
  });
});
