import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChatModality } from '@hushbox/shared';
import { TypingIndicator } from '@/components/chat/indicators/typing-indicator';

const activeModalityRef = { current: 'text' as ChatModality };

vi.mock('@/stores/model', () => ({
  useModelStore: <T,>(selector: (state: { activeModality: ChatModality }) => T): T =>
    selector({ activeModality: activeModalityRef.current }),
}));

describe('TypingIndicator', () => {
  const members = [
    { userId: 'u1', username: 'alice_smith' },
    { userId: 'u2', username: 'bob' },
    { userId: 'u3', username: 'carol' },
    { userId: 'u4', username: 'dave' },
  ];

  beforeEach(() => {
    activeModalityRef.current = 'text';
  });

  it('renders nothing when typingUserIds is empty', () => {
    const { container } = render(<TypingIndicator typingUserIds={new Set()} members={members} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows single user typing with username', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    expect(screen.getByText('Alice Smith is typing...')).toBeInTheDocument();
  });

  it('shows two users typing joined with "and"', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'u2'])} members={members} />);
    expect(screen.getByText('Alice Smith and Bob are typing...')).toBeInTheDocument();
  });

  it('shows "N people are typing..." for 3+ users', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'u2', 'u3'])} members={members} />);
    expect(screen.getByText('3 people are typing...')).toBeInTheDocument();
  });

  it('shows "N people are typing..." for 4 users', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'u2', 'u3', 'u4'])} members={members} />);
    expect(screen.getByText('4 people are typing...')).toBeInTheDocument();
  });

  it('falls back to "Someone" if userId not found in members', () => {
    render(<TypingIndicator typingUserIds={new Set(['unknown-id'])} members={members} />);
    expect(screen.getByText('Someone is typing...')).toBeInTheDocument();
  });

  it('falls back to "Someone" for unknown user mixed with known user', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'unknown-id'])} members={members} />);
    expect(screen.getByText('Alice Smith and Someone are typing...')).toBeInTheDocument();
  });

  it('renders "Someone" without throwing for a link-guest member with a null username', () => {
    const withGuest = [...members, { userId: 'guest', username: null }];
    expect(() =>
      render(<TypingIndicator typingUserIds={new Set(['guest'])} members={withGuest} />)
    ).not.toThrow();
    expect(screen.getByText('Someone is typing...')).toBeInTheDocument();
  });

  it('has correct aria-label matching display text for single user', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Alice Smith is typing...');
  });

  it('has correct aria-label matching display text for two users', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'u2'])} members={members} />);
    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      'Alice Smith and Bob are typing...'
    );
  });

  it('has correct aria-label for 3+ users', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'u2', 'u3'])} members={members} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '3 people are typing...');
  });

  it('has role="status" for screen reader live region', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('has data-testid="typing-indicator"', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    expect(screen.getByTestId('typing-indicator')).toBeInTheDocument();
  });

  it('renders three animated dots with animate-dot-pulse class', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    const dots = screen.getByTestId('typing-indicator').querySelectorAll('.animate-dot-pulse');
    expect(dots).toHaveLength(3);
  });

  it('dots container has aria-hidden="true"', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    const dots = screen.getByTestId('typing-indicator').querySelectorAll('.animate-dot-pulse');
    const dotsContainer = dots[0]!.parentElement!;
    expect(dotsContainer).toHaveAttribute('aria-hidden', 'true');
  });

  it('each dot has staggered animation-delay', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    const dots = screen.getByTestId('typing-indicator').querySelectorAll('.animate-dot-pulse');
    expect(dots[0]).toHaveStyle({ animationDelay: '0s' });
    expect(dots[1]).toHaveStyle({ animationDelay: '0.16s' });
    expect(dots[2]).toHaveStyle({ animationDelay: '0.32s' });
  });

  it('uses foreground text color', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    expect(screen.getByTestId('typing-indicator')).toHaveClass('text-foreground');
  });

  describe('modality-aware copy', () => {
    it('shows "is generating an image..." for single user in image modality', () => {
      activeModalityRef.current = 'image';
      render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
      expect(screen.getByText('Alice Smith is generating an image...')).toBeInTheDocument();
    });

    it('shows "is generating a video..." for single user in video modality', () => {
      activeModalityRef.current = 'video';
      render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
      expect(screen.getByText('Alice Smith is generating a video...')).toBeInTheDocument();
    });

    it('shows "is generating audio..." for single user in audio modality', () => {
      activeModalityRef.current = 'audio';
      render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
      expect(screen.getByText('Alice Smith is generating audio...')).toBeInTheDocument();
    });

    it('shows "are generating images..." for two users in image modality', () => {
      activeModalityRef.current = 'image';
      render(<TypingIndicator typingUserIds={new Set(['u1', 'u2'])} members={members} />);
      expect(screen.getByText('Alice Smith and Bob are generating images...')).toBeInTheDocument();
    });

    it('shows "are generating videos..." for two users in video modality', () => {
      activeModalityRef.current = 'video';
      render(<TypingIndicator typingUserIds={new Set(['u1', 'u2'])} members={members} />);
      expect(screen.getByText('Alice Smith and Bob are generating videos...')).toBeInTheDocument();
    });

    it('shows "3 people are generating images..." for 3+ users in image modality', () => {
      activeModalityRef.current = 'image';
      render(<TypingIndicator typingUserIds={new Set(['u1', 'u2', 'u3'])} members={members} />);
      expect(screen.getByText('3 people are generating images...')).toBeInTheDocument();
    });

    it('matches aria-label to display text for image modality (single user)', () => {
      activeModalityRef.current = 'image';
      render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
      expect(screen.getByRole('status')).toHaveAttribute(
        'aria-label',
        'Alice Smith is generating an image...'
      );
    });
  });
});
