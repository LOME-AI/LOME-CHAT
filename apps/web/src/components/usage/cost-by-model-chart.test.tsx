import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { CostByModelChart } from './cost-by-model-chart';
import type { CostByModelResponse } from '@hushbox/shared';

// Recharts ResponsiveContainer needs real width/height to render children; jsdom
// has no layout engine, so pass dimensions through a stub.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 300 }}>{children}</div>
    ),
  };
});

type Row = CostByModelResponse['data'][number];

function makeData(rows: Pick<Row, 'model' | 'totalCost' | 'messageCount'>[]): CostByModelResponse {
  return {
    data: rows.map((r) => ({
      provider: 'openrouter',
      totalInputTokens: 100,
      totalOutputTokens: 200,
      ...r,
    })),
  };
}

const SAMPLE_DATA = makeData([
  { model: 'GPT-4', totalCost: '1.50', messageCount: 10 },
  { model: 'Claude', totalCost: '2.00', messageCount: 5 },
]);

describe('CostByModelChart', () => {
  describe('loading state', () => {
    it('renders skeleton when loading', () => {
      render(<CostByModelChart data={undefined} isLoading={true} />);
      expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
    });

    it('does not render empty message when loading', () => {
      render(<CostByModelChart data={undefined} isLoading={true} />);
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('renders empty message when data is undefined', () => {
      render(<CostByModelChart data={undefined} isLoading={false} />);
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('renders empty message when data array is empty', () => {
      render(<CostByModelChart data={makeData([])} isLoading={false} />);
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('does not render skeleton when not loading', () => {
      render(<CostByModelChart data={undefined} isLoading={false} />);
      expect(screen.queryByTestId(TEST_IDS.skeletonBlock)).not.toBeInTheDocument();
    });
  });

  describe('chart rendering', () => {
    it('renders chart card with correct testid', () => {
      render(<CostByModelChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.costByModelChart)).toBeInTheDocument();
    });

    it('renders the title', () => {
      render(<CostByModelChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByText('Cost by Model')).toBeInTheDocument();
    });

    it('does not render empty message when data exists', () => {
      render(<CostByModelChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });

    it('renders the chart surface for a single row', () => {
      const single = makeData([{ model: 'GPT-4', totalCost: '0.75', messageCount: 3 }]);
      const { container } = render(<CostByModelChart data={single} isLoading={false} />);
      expect(container.querySelector('[data-chart]')).toBeInTheDocument();
    });
  });
});
