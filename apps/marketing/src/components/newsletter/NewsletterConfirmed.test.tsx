import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { friendlyErrorMessage } from '@hushbox/shared';
import { NewsletterConfirmed } from './NewsletterConfirmed';
import * as hookModule from './use-token-action';
import type { TokenActionState } from './use-token-action';

function mockAction(state: TokenActionState): void {
  vi.spyOn(hookModule, 'useTokenAction').mockReturnValue(state);
}

describe('NewsletterConfirmed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('confirms against /newsletter/confirm', () => {
    const spy = vi
      .spyOn(hookModule, 'useTokenAction')
      .mockReturnValue({ status: 'pending', code: null });
    render(<NewsletterConfirmed />);
    expect(spy).toHaveBeenCalledWith('/newsletter/confirm');
  });

  it('shows only a visually hidden status while pending, leaving the cipher texture bare', () => {
    mockAction({ status: 'pending', code: null });
    render(<NewsletterConfirmed />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Confirming your subscription');
    expect(status).toHaveClass('sr-only');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('reveals the signature success moment', () => {
    mockAction({ status: 'success', code: null });
    render(<NewsletterConfirmed />);
    expect(screen.getByRole('heading', { name: "You're on the list." })).toBeInTheDocument();
    expect(
      screen.getByText("Expect a few letters a year, written when there's something worth saying.")
    ).toBeInTheDocument();
  });

  it('offers a ghost link to the blog on success', () => {
    mockAction({ status: 'success', code: null });
    render(<NewsletterConfirmed />);
    expect(screen.getByRole('link', { name: 'Read the blog' })).toHaveAttribute('href', '/blog');
  });

  it('shows the friendly error and a signup link for an invalid token', () => {
    mockAction({ status: 'error', code: 'NEWSLETTER_CONFIRM_INVALID' });
    render(<NewsletterConfirmed />);
    expect(
      screen.getByText(friendlyErrorMessage('NEWSLETTER_CONFIRM_INVALID'))
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign up again' })).toHaveAttribute(
      'href',
      '/newsletter'
    );
  });

  it('falls back to the generic friendly message when the error has no code', () => {
    mockAction({ status: 'error', code: null });
    render(<NewsletterConfirmed />);
    expect(screen.getByText(friendlyErrorMessage('UNKNOWN'))).toBeInTheDocument();
  });

  it('shows a neutral signup pointer when the URL has no token', () => {
    mockAction({ status: 'missing', code: null });
    render(<NewsletterConfirmed />);
    expect(
      screen.getByText('This page confirms a newsletter signup from the link in your email.')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign up for the newsletter' })).toHaveAttribute(
      'href',
      '/newsletter'
    );
  });
});
