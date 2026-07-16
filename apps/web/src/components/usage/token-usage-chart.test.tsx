import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { TokenUsageChart } from './token-usage-chart';
import { formatPeriodLabel } from './chart-utilities';
import type { TokenUsageOverTimeResponse } from '@hushbox/shared';

// Recharts ResponsiveContainer needs a real width/height to render children.
// In jsdom there is no layout engine, so we mock it to pass dimensions through.
// BarChart is captured as a passthrough so we can assert the accessibilityLayer
// prop is forwarded (recharts only emits the focusable surface with real layout).
const barChartProps: unknown[] = [];
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  const ActualBarChart = actual.BarChart;
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 300 }}>{children}</div>
    ),
    BarChart: (props: React.ComponentProps<typeof ActualBarChart>) => {
      barChartProps.push(props);
      // Inject explicit dimensions so recharts computes scales and renders bars
      // under jsdom (no layout engine), enabling tooltip activation in tests.
      return <ActualBarChart {...props} width={800} height={300} />;
    },
  };
});

vi.mock('./chart-utilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chart-utilities')>();
  return { ...actual, formatPeriodLabel: vi.fn(actual.formatPeriodLabel) };
});

function makeData(
  points: { period: string; inputTokens: number; outputTokens: number; cachedTokens: number }[]
): TokenUsageOverTimeResponse {
  return { data: points };
}

const SAMPLE_DATA = makeData([
  { period: '2025-01-01', inputTokens: 100, outputTokens: 50, cachedTokens: 10 },
  { period: '2025-01-02', inputTokens: 200, outputTokens: 80, cachedTokens: 20 },
]);

describe('TokenUsageChart', () => {
  describe('loading state', () => {
    it('renders skeleton when loading', () => {
      render(<TokenUsageChart data={undefined} isLoading={true} />);
      expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('renders empty message when data is undefined', () => {
      render(<TokenUsageChart data={undefined} isLoading={false} />);
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('renders empty message when data array is empty', () => {
      render(<TokenUsageChart data={makeData([])} isLoading={false} />);
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });
  });

  describe('chart rendering', () => {
    it('renders chart card with correct testid', () => {
      render(<TokenUsageChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.tokenUsageChart)).toBeInTheDocument();
    });

    it('renders title', () => {
      render(<TokenUsageChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByText('Token Usage')).toBeInTheDocument();
    });

    it('formats period labels via the shared UTC-aware formatter', () => {
      render(<TokenUsageChart data={SAMPLE_DATA} isLoading={false} />);
      expect(formatPeriodLabel).toHaveBeenCalledWith('2025-01-01');
      expect(formatPeriodLabel).toHaveBeenCalledWith('2025-01-02');
    });
  });

  describe('accessibility', () => {
    it('exposes the chart as an image region with an accessible name', () => {
      render(<TokenUsageChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByRole('img', { name: /Token Usage/i })).toBeInTheDocument();
    });

    it('renders a data-table alternative labelling each token series by name', () => {
      render(<TokenUsageChart data={SAMPLE_DATA} isLoading={false} />);
      const table = screen.getByRole('table', { hidden: true });
      expect(table.closest('.sr-only')).not.toBeNull();
      const headers = screen
        .getAllByRole('columnheader', { hidden: true })
        .map((h) => h.textContent);
      expect(headers).toEqual(expect.arrayContaining(['Input', 'Output', 'Cached']));
    });

    it('enables the recharts accessibility layer for keyboard reachability', () => {
      barChartProps.length = 0;
      render(<TokenUsageChart data={SAMPLE_DATA} isLoading={false} />);
      expect(barChartProps.at(0)).toMatchObject({ accessibilityLayer: true });
    });

    it('renders a singular-period aria label for a single period', () => {
      // Exercises the `chartData.length === 1 ? '' : 's'` singular branch.
      render(
        <TokenUsageChart
          data={makeData([
            { period: '2025-01-01', inputTokens: 100, outputTokens: 50, cachedTokens: 10 },
          ])}
          isLoading={false}
        />
      );

      expect(screen.getByLabelText(/across 1 period\./)).toBeInTheDocument();
    });

    it('formats token values in the tooltip', async () => {
      const user = userEvent.setup();
      const { container } = render(<TokenUsageChart data={SAMPLE_DATA} isLoading={false} />);

      // Activate the tooltip by keyboard on the recharts accessibility surface;
      // rendering it invokes the inline value formatter for each token count.
      const surface = container.querySelector('.recharts-surface');
      expect(surface).not.toBeNull();
      (surface as SVGElement).focus();
      await user.keyboard('{ArrowRight}');

      const tooltips = await screen.findAllByText('100');
      expect(tooltips.length).toBeGreaterThan(0);
    });
  });
});
