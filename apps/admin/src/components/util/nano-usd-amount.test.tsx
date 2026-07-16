import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NanoUsdAmount } from './nano-usd-amount.js';

describe('NanoUsdAmount', () => {
  it('renders the dollar rendering with the exact wire string in the title', () => {
    render(<NanoUsdAmount wire="5000000000" />);

    const amount = screen.getByText('$5.00');
    expect(amount).toHaveAttribute('title', '5000000000 nano-USD');
    expect(amount).toHaveClass('tabular-nums');
  });

  it('styles a negative amount as destructive', () => {
    render(<NanoUsdAmount wire="-2500000000" />);

    expect(screen.getByText('-$2.50')).toHaveClass('text-destructive');
  });

  it('does not style a positive amount as destructive', () => {
    render(<NanoUsdAmount wire="1000000000" />);

    expect(screen.getByText('$1.00')).not.toHaveClass('text-destructive');
  });
});
