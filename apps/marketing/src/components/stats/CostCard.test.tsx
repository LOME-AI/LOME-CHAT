import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostCard } from './CostCard';

const COST = { avgUsd: '0.0051', medianUsd: '0.0030', p90Usd: '0.02' };

describe('CostCard', () => {
  it('renders the average as the hero figure', () => {
    render(<CostCard cost={COST} />);
    expect(screen.getByText('$0.0051')).toBeInTheDocument();
    expect(screen.getByText('average cost per message')).toBeInTheDocument();
  });

  it('renders the median and p90 figures', () => {
    render(<CostCard cost={COST} />);
    expect(screen.getByText('$0.003')).toBeInTheDocument();
    expect(screen.getByText('median')).toBeInTheDocument();
    expect(screen.getByText('$0.02')).toBeInTheDocument();
    expect(screen.getByText('p90')).toBeInTheDocument();
  });
});
