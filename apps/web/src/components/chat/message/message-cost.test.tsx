import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageCost } from '@/components/chat/message/message-cost';

describe('MessageCost', () => {
  it('renders a NanoUSD wire cost with sub-cent precision', () => {
    render(<MessageCost cost="1360000" />);

    expect(screen.getByTestId('message-cost')).toHaveTextContent('$0.00136');
  });

  it('renders a zero NanoUSD cost as $0.00', () => {
    render(<MessageCost cost="0" />);

    expect(screen.getByTestId('message-cost')).toHaveTextContent('$0.00');
  });

  it('renders a very small NanoUSD cost with full precision', () => {
    render(<MessageCost cost="21000" />);

    expect(screen.getByTestId('message-cost')).toHaveTextContent('$0.000021');
  });

  it('strips trailing zeros from the display', () => {
    render(<MessageCost cost="15000000" />);

    expect(screen.getByTestId('message-cost')).toHaveTextContent('$0.015');
  });

  it('renders no badge and does not throw for a non-canonical cost string', () => {
    expect(() => render(<MessageCost cost="0.01" />)).not.toThrow();

    expect(screen.queryByTestId('message-cost')).toBeNull();
  });
});
