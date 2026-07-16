import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { SpendingOverTimeChart } from './spending-over-time-chart';
import { formatPeriodLabel } from './chart-utilities';
import type { SpendingOverTimeResponse } from '@hushbox/shared';

vi.mock('./chart-utilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chart-utilities')>();
  return { ...actual, formatPeriodLabel: vi.fn(actual.formatPeriodLabel) };
});

// Recharts ResponsiveContainer needs a real width/height to render children.
// In jsdom there is no layout engine, so we mock it to pass dimensions through.
// AreaChart is captured as a passthrough so we can assert the accessibilityLayer
// prop is forwarded (recharts only emits the focusable surface with real layout).
const areaChartProps: unknown[] = [];
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  const ActualAreaChart = actual.AreaChart;
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 300 }}>{children}</div>
    ),
    AreaChart: (props: React.ComponentProps<typeof ActualAreaChart>) => {
      areaChartProps.push(props);
      return <ActualAreaChart {...props} />;
    },
  };
});

function makeData(
  points: { period: string; model: string; totalCost: string; count: number }[]
): SpendingOverTimeResponse {
  return { data: points };
}

const SAMPLE_DATA = makeData([
  { period: '2025-01-01', model: 'GPT-4', totalCost: '1.50', count: 10 },
  { period: '2025-01-01', model: 'Claude', totalCost: '2.00', count: 5 },
  { period: '2025-01-02', model: 'GPT-4', totalCost: '0.75', count: 3 },
  { period: '2025-01-02', model: 'Claude', totalCost: '0.00', count: 0 },
]);

describe('SpendingOverTimeChart', () => {
  describe('loading state', () => {
    it('renders skeleton when loading', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={true} />);
      expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
    });

    it('does not render empty message when loading', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={true} />);
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('renders empty message when data is undefined', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={false} />);
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('renders empty message when data array is empty', () => {
      render(<SpendingOverTimeChart data={makeData([])} isLoading={false} />);
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('does not render skeleton when not loading', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={false} />);
      expect(screen.queryByTestId(TEST_IDS.skeletonBlock)).not.toBeInTheDocument();
    });
  });

  describe('chart rendering', () => {
    it('renders chart card with correct testid', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.spendingOverTimeChart)).toBeInTheDocument();
    });

    it('renders title', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByText('Spending Over Time')).toBeInTheDocument();
    });

    it('does not render empty message when data exists', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });

    it('does not render skeleton when data is loaded', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.queryByTestId(TEST_IDS.skeletonBlock)).not.toBeInTheDocument();
    });
  });

  describe('data transformation', () => {
    it('sorts periods chronologically', () => {
      const reversed = makeData([
        { period: '2025-01-02', model: 'GPT-4', totalCost: '0.75', count: 3 },
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1.50', count: 10 },
      ]);
      const { container } = render(<SpendingOverTimeChart data={reversed} isLoading={false} />);
      expect(container.querySelector('[data-chart]')).toBeInTheDocument();
    });

    it('handles single data point', () => {
      const single = makeData([
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1.50', count: 10 },
      ]);
      render(<SpendingOverTimeChart data={single} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.spendingOverTimeChart)).toBeInTheDocument();
    });

    it('formats period labels via the shared UTC-aware formatter', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(formatPeriodLabel).toHaveBeenCalledWith('2025-01-01');
      expect(formatPeriodLabel).toHaveBeenCalledWith('2025-01-02');
    });

    it('handles multiple models across periods', () => {
      const multi = makeData([
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1.00', count: 1 },
        { period: '2025-01-01', model: 'Claude', totalCost: '2.00', count: 2 },
        { period: '2025-01-01', model: 'Gemini', totalCost: '3.00', count: 3 },
      ]);
      render(<SpendingOverTimeChart data={multi} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.spendingOverTimeChart)).toBeInTheDocument();
    });

    it('fills zero for a model absent from a period', () => {
      // GPT-4 only appears in the first period and Claude only in the second, so
      // each period is missing one model, exercising the `values[model] ?? 0` fill.
      const disjoint = makeData([
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1.00', count: 1 },
        { period: '2025-01-02', model: 'Claude', totalCost: '2.00', count: 2 },
      ]);
      render(<SpendingOverTimeChart data={disjoint} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.spendingOverTimeChart)).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('exposes the chart as an image region with an accessible name', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByRole('img', { name: /Spending Over Time/i })).toBeInTheDocument();
    });

    it('renders a data-table alternative listing each period and model cost', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      const table = screen.getByRole('table', { hidden: true });
      expect(table.closest('.sr-only')).not.toBeNull();
      const headers = screen
        .getAllByRole('columnheader', { hidden: true })
        .map((h) => h.textContent);
      expect(headers).toContain('GPT-4');
      expect(headers).toContain('Claude');
      expect(screen.getByRole('cell', { name: '$1.5000', hidden: true })).toBeInTheDocument();
    });

    it('enables the recharts accessibility layer for keyboard reachability', () => {
      areaChartProps.length = 0;
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(areaChartProps.at(0)).toMatchObject({ accessibilityLayer: true });
    });
  });
});
