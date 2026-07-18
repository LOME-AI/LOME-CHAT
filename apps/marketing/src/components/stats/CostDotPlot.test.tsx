import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CostDotPlot } from './CostDotPlot';
import type { DotPlotEntry } from './compute-stats';

const ENTRIES: readonly DotPlotEntry[] = [
  {
    rank: 1,
    modelId: 'b/two',
    displayName: 'Two',
    provider: 'b',
    sharePercent: 50,
    deltaPoints: null,
    avgCostUsd: '0.002',
    color: 'var(--chart-1)',
    position: 0,
  },
  {
    rank: 2,
    modelId: 'a/one',
    displayName: 'One',
    provider: 'a',
    sharePercent: 40,
    deltaPoints: null,
    avgCostUsd: '0.0100',
    color: 'var(--chart-2)',
    position: 100,
  },
];

describe('CostDotPlot', () => {
  it('renders a row per entry with the model name and formatted cost', () => {
    render(<CostDotPlot entries={ENTRIES} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Two')).toBeInTheDocument();
    expect(within(items[0]).getByText('$0.002')).toBeInTheDocument();
    expect(within(items[1]).getByText('$0.01')).toBeInTheDocument();
  });

  it('positions each dot on the log-scale track', () => {
    const { container } = render(<CostDotPlot entries={ENTRIES} />);
    const dots = container.querySelectorAll('[data-dot]');
    expect(dots).toHaveLength(2);
    expect((dots[0] as HTMLElement).style.left).toBe('0%');
    expect((dots[1] as HTMLElement).style.left).toBe('100%');
  });

  it('widens the truncating label column at the desktop breakpoint', () => {
    render(<CostDotPlot entries={ENTRIES} />);
    const label = screen.getByText('Two');
    expect(label).toHaveClass('truncate', 'w-40', 'md:w-64');
  });

  it('colors each dot with the model chart token', () => {
    const { container } = render(<CostDotPlot entries={ENTRIES} />);
    const circles = container.querySelectorAll('circle');
    expect(circles[0].getAttribute('fill')).toBe('var(--chart-1)');
  });
});
