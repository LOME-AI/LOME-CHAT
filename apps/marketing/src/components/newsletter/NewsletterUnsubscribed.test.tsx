import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { friendlyErrorMessage } from '@hushbox/shared';
import { NewsletterUnsubscribed } from './NewsletterUnsubscribed';
import * as hookModule from './use-token-action';
import type { TokenActionState } from './use-token-action';

function mockAction(state: TokenActionState): void {
  vi.spyOn(hookModule, 'useTokenAction').mockReturnValue(state);
}

describe('NewsletterUnsubscribed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('unsubscribes against /newsletter/unsubscribe', () => {
    const spy = vi
      .spyOn(hookModule, 'useTokenAction')
      .mockReturnValue({ status: 'pending', code: null });
    render(<NewsletterUnsubscribed />);
    expect(spy).toHaveBeenCalledWith('/newsletter/unsubscribe');
  });

  it('shows a quiet status while pending', () => {
    mockAction({ status: 'pending', code: null });
    render(<NewsletterUnsubscribed />);
    expect(screen.getByRole('status')).toHaveTextContent('Unsubscribing');
  });

  it('confirms the unsubscribe plainly on success', () => {
    mockAction({ status: 'success', code: null });
    render(<NewsletterUnsubscribed />);
    expect(screen.getByRole('heading', { name: "You're unsubscribed." })).toBeInTheDocument();
    expect(screen.getByText('No further emails.')).toBeInTheDocument();
  });

  it('offers a way back in on success without pressure', () => {
    mockAction({ status: 'success', code: null });
    render(<NewsletterUnsubscribed />);
    expect(screen.getByRole('link', { name: 'Changed your mind? Sign up again' })).toHaveAttribute(
      'href',
      '/newsletter'
    );
  });

  it('shows the friendly error and a signup link for an invalid token', () => {
    mockAction({ status: 'error', code: 'NEWSLETTER_UNSUBSCRIBE_INVALID' });
    render(<NewsletterUnsubscribed />);
    expect(
      screen.getByText(friendlyErrorMessage('NEWSLETTER_UNSUBSCRIBE_INVALID'))
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the newsletter page' })).toHaveAttribute(
      'href',
      '/newsletter'
    );
  });

  it('treats a missing token as an invalid unsubscribe link', () => {
    mockAction({ status: 'missing', code: null });
    render(<NewsletterUnsubscribed />);
    expect(
      screen.getByText(friendlyErrorMessage('NEWSLETTER_UNSUBSCRIBE_INVALID'))
    ).toBeInTheDocument();
  });
});
