import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InlineFormError } from './inline-form-error';

describe('InlineFormError', () => {
  it('renders nothing when error is null', () => {
    const { container } = render(<InlineFormError error={null} errorKey={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the error message when provided', () => {
    render(<InlineFormError error="Invalid credentials" errorKey={0} />);
    expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
  });

  it('has role="alert" so screen readers announce it', () => {
    render(<InlineFormError error="Error" errorKey={0} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('has animate-shake class to draw attention', () => {
    render(<InlineFormError error="Error" errorKey={0} />);
    expect(screen.getByRole('alert')).toHaveClass('animate-shake');
  });

  it('uses errorKey as React key so consecutive identical errors retrigger animation', () => {
    const { rerender } = render(<InlineFormError error="Same message" errorKey={0} />);
    const first = screen.getByRole('alert');
    rerender(<InlineFormError error="Same message" errorKey={1} />);
    const second = screen.getByRole('alert');
    // Different React key forces a fresh mount — a new DOM node — so the
    // animation re-fires even when the message text is unchanged.
    expect(second).not.toBe(first);
  });

  it('uses destructive text styling', () => {
    render(<InlineFormError error="Error" errorKey={0} />);
    const element = screen.getByRole('alert');
    expect(element).toHaveClass('text-destructive');
    expect(element).toHaveClass('text-center');
    expect(element).toHaveClass('text-sm');
  });

  it('applies the id attribute when provided', () => {
    render(<InlineFormError error="Error" errorKey={0} id="password-error" />);
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'password-error');
  });

  it('omits the id attribute when not provided', () => {
    render(<InlineFormError error="Error" errorKey={0} />);
    expect(screen.getByRole('alert')).not.toHaveAttribute('id');
  });
});
