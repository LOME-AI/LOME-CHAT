import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RankedList } from './RankedList';
import type { RankedModel } from './compute-stats';

const MODELS: readonly RankedModel[] = [
  {
    rank: 1,
    modelId: 'b/two',
    displayName: 'Two',
    provider: 'b',
    sharePercent: 50,
    deltaPoints: -0.4,
    avgCostUsd: '0.002',
    color: 'var(--chart-1)',
  },
  {
    rank: 2,
    modelId: 'a/one',
    displayName: 'One',
    provider: 'a',
    sharePercent: 40,
    deltaPoints: null,
    avgCostUsd: '0.01',
    color: 'var(--chart-2)',
  },
];

const OTHERS = { sharePercent: 10, deltaPoints: 1.5 };

describe('RankedList', () => {
  it('renders one row per model plus Others last', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('Two')).toBeInTheDocument();
    expect(within(items[2]).getByText('Others')).toBeInTheDocument();
  });

  it('renders rank numbers and share percentages', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]).getByText('1')).toBeInTheDocument();
    expect(within(items[0]).getByText('50.0%')).toBeInTheDocument();
    expect(within(items[2]).getByText('10.0%')).toBeInTheDocument();
  });

  it('renders a signed delta badge when deltas are shown', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    expect(screen.getByText('-0.4')).toBeInTheDocument();
    expect(screen.getByText('+1.5')).toBeInTheDocument();
  });

  it('omits the delta badge for a null delta even when deltas are shown', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    const items = screen.getAllByRole('listitem');
    expect(within(items[1]).queryByText(/^[+-]/)).not.toBeInTheDocument();
  });

  it('omits the Others row when its share is zero', () => {
    render(
      <RankedList
        models={MODELS}
        others={{ sharePercent: 0, deltaPoints: null }}
        showDelta={true}
      />
    );
    expect(screen.queryByText('Others')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the Others row when its share is nonzero', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    expect(screen.getByText('Others')).toBeInTheDocument();
  });

  it('renders positive deltas in default ink for light mode and success only in dark mode', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    const positive = screen.getByText('+1.5');
    expect(positive).toHaveClass('text-foreground', 'dark:text-success');
    expect(positive).not.toHaveClass('text-success');
  });

  it('omits all deltas when the window has none', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={false} />);
    expect(screen.queryByText('-0.4')).not.toBeInTheDocument();
    expect(screen.queryByText('+1.5')).not.toBeInTheDocument();
  });
});
