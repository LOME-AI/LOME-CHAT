import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { UsageKpiCards } from './usage-kpi-cards';
import type { UsageSummaryResponse } from '@hushbox/shared';

function makeSummary(overrides: Partial<UsageSummaryResponse> = {}): UsageSummaryResponse {
  return {
    totalSpent: '12.50',
    messageCount: 20,
    totalInputTokens: 1000,
    totalOutputTokens: 2000,
    totalCachedTokens: 500,
    ...overrides,
  } as UsageSummaryResponse;
}

function kpiValue(testId: string): HTMLElement {
  return screen.getByTestId(TEST_ID_BUILDERS.kpiValue(testId));
}

describe('UsageKpiCards', () => {
  describe('loading state', () => {
    it('renders skeletons for every card while loading', () => {
      render(<UsageKpiCards data={undefined} isLoading={true} />);
      // Two skeleton blocks per card, four cards.
      expect(screen.getAllByTestId(TEST_IDS.skeletonBlock)).toHaveLength(8);
    });

    it('does not render values while loading', () => {
      render(<UsageKpiCards data={makeSummary()} isLoading={true} />);
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.kpiValue(TEST_IDS.kpiTotalSpent))
      ).not.toBeInTheDocument();
    });
  });

  describe('with data', () => {
    it('renders the KPI container', () => {
      render(<UsageKpiCards data={makeSummary()} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.usageKpiCards)).toBeInTheDocument();
    });

    it('formats total spent above one cent with two decimals', () => {
      render(<UsageKpiCards data={makeSummary({ totalSpent: '12.50' })} isLoading={false} />);
      expect(kpiValue(TEST_IDS.kpiTotalSpent)).toHaveTextContent('$12.50');
    });

    it('formats a sub-cent total spent with four decimals', () => {
      render(<UsageKpiCards data={makeSummary({ totalSpent: '0.0042' })} isLoading={false} />);
      expect(kpiValue(TEST_IDS.kpiTotalSpent)).toHaveTextContent('$0.0042');
    });

    it('formats a zero total spent as $0.00', () => {
      render(<UsageKpiCards data={makeSummary({ totalSpent: '0' })} isLoading={false} />);
      expect(kpiValue(TEST_IDS.kpiTotalSpent)).toHaveTextContent('$0.00');
    });

    it('renders the message count', () => {
      render(<UsageKpiCards data={makeSummary({ messageCount: 20 })} isLoading={false} />);
      expect(kpiValue(TEST_IDS.kpiMessages)).toHaveTextContent('20');
    });

    it('sums input, output, and cached tokens', () => {
      render(
        <UsageKpiCards
          data={makeSummary({
            totalInputTokens: 1000,
            totalOutputTokens: 2000,
            totalCachedTokens: 500,
          })}
          isLoading={false}
        />
      );
      // 3500 formats as 3.5K
      expect(kpiValue(TEST_IDS.kpiTokens)).toHaveTextContent('3.5K');
    });

    it('computes average cost per message', () => {
      render(
        <UsageKpiCards
          data={makeSummary({ totalSpent: '10', messageCount: 20 })}
          isLoading={false}
        />
      );
      // 10 / 20 = 0.5 → sub-cent path is false (>= 0.01) → $0.50
      expect(kpiValue(TEST_IDS.kpiAvgCost)).toHaveTextContent('$0.50');
    });
  });

  describe('undefined data (not loading)', () => {
    it('falls back to zeroed KPIs', () => {
      render(<UsageKpiCards data={undefined} isLoading={false} />);
      expect(kpiValue(TEST_IDS.kpiTotalSpent)).toHaveTextContent('$0.00');
      expect(kpiValue(TEST_IDS.kpiMessages)).toHaveTextContent('0');
      expect(kpiValue(TEST_IDS.kpiTokens)).toHaveTextContent('0');
      expect(kpiValue(TEST_IDS.kpiAvgCost)).toHaveTextContent('$0.00');
    });

    it('avoids divide-by-zero when message count is zero', () => {
      render(
        <UsageKpiCards
          data={makeSummary({ totalSpent: '10', messageCount: 0 })}
          isLoading={false}
        />
      );
      expect(kpiValue(TEST_IDS.kpiAvgCost)).toHaveTextContent('$0.00');
    });
  });
});
