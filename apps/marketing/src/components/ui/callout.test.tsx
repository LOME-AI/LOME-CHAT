import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Callout } from './callout';

describe('Callout', () => {
  it('renders children', () => {
    render(<Callout>Callout content</Callout>);
    expect(screen.getByText('Callout content')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<Callout data-testid="callout">Content</Callout>);
    expect(screen.getByTestId('callout')).toHaveAttribute('data-slot', 'callout');
  });

  it('applies custom className', () => {
    render(
      <Callout className="custom-class" data-testid="callout">
        Content
      </Callout>
    );
    expect(screen.getByTestId('callout')).toHaveClass('custom-class');
  });

  it('renders title when provided', () => {
    render(<Callout title="Simply Put">Content</Callout>);
    expect(screen.getByText('Simply Put')).toBeInTheDocument();
  });

  it('applies variant as data attribute', () => {
    render(
      <Callout variant="privacy" data-testid="callout">
        Content
      </Callout>
    );
    expect(screen.getByTestId('callout')).toHaveAttribute('data-variant', 'privacy');
  });

  it('defaults to info variant', () => {
    render(<Callout data-testid="callout">Content</Callout>);
    expect(screen.getByTestId('callout')).toHaveAttribute('data-variant', 'info');
  });

  it('applies the warning variant styling', () => {
    render(
      <Callout variant="warning" data-testid="callout">
        Content
      </Callout>
    );
    const el = screen.getByTestId('callout');
    expect(el).toHaveAttribute('data-variant', 'warning');
    expect(el).toHaveClass('border-warning/30');
  });
});
