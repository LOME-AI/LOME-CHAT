import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { BalanceHistoryChart } from './balance-history-chart';
import { formatPeriodLabel } from './chart-utilities';
import type { BalanceHistoryResponse } from '@hushbox/shared';

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

vi.mock('./chart-utilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chart-utilities')>();
  return { ...actual, formatPeriodLabel: vi.fn(actual.formatPeriodLabel) };
});

function makeData(
  points: { createdAt: string; balanceAfter: string; entryType: string; amount: string }[]
): BalanceHistoryResponse {
  return { data: points };
}

const SAMPLE_DATA = makeData([
  { createdAt: '2025-01-01', balanceAfter: '5.00', entryType: 'debit', amount: '-1.00' },
  { createdAt: '2025-01-02', balanceAfter: '4.00', entryType: 'debit', amount: '-1.00' },
]);

describe('BalanceHistoryChart', () => {
  describe('loading state', () => {
    it('renders skeleton when loading', () => {
      render(<BalanceHistoryChart data={undefined} isLoading={true} />);
      expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('renders empty message when data is undefined', () => {
      render(<BalanceHistoryChart data={undefined} isLoading={false} />);
      expect(screen.getByText('No balance history')).toBeInTheDocument();
    });

    it('renders empty message when data array is empty', () => {
      render(<BalanceHistoryChart data={makeData([])} isLoading={false} />);
      expect(screen.getByText('No balance history')).toBeInTheDocument();
    });
  });

  describe('chart rendering', () => {
    it('renders chart card with correct testid', () => {
      render(<BalanceHistoryChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.balanceHistoryChart)).toBeInTheDocument();
    });

    it('renders title', () => {
      render(<BalanceHistoryChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByText('Balance History')).toBeInTheDocument();
    });

    it('formats date labels via the shared UTC-aware formatter', () => {
      render(<BalanceHistoryChart data={SAMPLE_DATA} isLoading={false} />);
      expect(formatPeriodLabel).toHaveBeenCalledWith('2025-01-01');
      expect(formatPeriodLabel).toHaveBeenCalledWith('2025-01-02');
    });
  });

  describe('accessibility', () => {
    it('exposes the chart as an image region with an accessible name', () => {
      render(<BalanceHistoryChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByRole('img', { name: /Balance History/i })).toBeInTheDocument();
    });

    it('renders a data-table alternative listing date and balance', () => {
      render(<BalanceHistoryChart data={SAMPLE_DATA} isLoading={false} />);
      const table = screen.getByRole('table', { hidden: true });
      expect(table.closest('.sr-only')).not.toBeNull();
      expect(screen.getByRole('cell', { name: '$5.0000', hidden: true })).toBeInTheDocument();
    });

    it('enables the recharts accessibility layer for keyboard reachability', () => {
      areaChartProps.length = 0;
      render(<BalanceHistoryChart data={SAMPLE_DATA} isLoading={false} />);
      expect(areaChartProps.at(0)).toMatchObject({ accessibilityLayer: true });
    });
  });

  describe('multiple ledger entries on the same calendar day', () => {
    it('renders without a duplicate React key warning', () => {
      // The balance-history endpoint returns raw, ungrouped ledger entries, so
      // several can fall on one calendar day. Keying the sr-only table rows on
      // the formatted "Mon D" label collapses same-day entries to one key,
      // which makes React log "Encountered two children with the same key" —
      // and the E2E console-error gate treats that as a failure.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(vi.fn());

      render(
        <BalanceHistoryChart
          data={makeData([
            {
              createdAt: '2025-01-01T08:00:00Z',
              balanceAfter: '5.00',
              entryType: 'charge',
              amount: '-1.00',
            },
            {
              createdAt: '2025-01-01T20:00:00Z',
              balanceAfter: '4.00',
              entryType: 'charge',
              amount: '-1.00',
            },
          ])}
          isLoading={false}
        />
      );

      const sawDuplicateKeyWarning = consoleError.mock.calls.some((args) =>
        args.some((argument) => typeof argument === 'string' && argument.includes('same key'))
      );
      consoleError.mockRestore();

      expect(sawDuplicateKeyWarning).toBe(false);
    });

    it('renders a singular-point aria label for a single data point', () => {
      // Exercises the `chartData.length === 1 ? '' : 's'` singular branch.
      render(
        <BalanceHistoryChart
          data={makeData([
            { createdAt: '2025-01-01', balanceAfter: '5.00', entryType: 'debit', amount: '-1.00' },
          ])}
          isLoading={false}
        />
      );

      expect(screen.getByLabelText(/across 1 point\./)).toBeInTheDocument();
    });
  });
});
