import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ALL_FEE_CATEGORIES, FEE_BUCKET_BY_ID, FEE_CATEGORIES, TEST_IDS } from '@hushbox/shared';
import { CostPieChart } from './cost-pie-chart';

function expectedSliceCount(): number {
  // Service Value is always rendered. Transaction Costs and Platform Fee
  // are rendered only if they contain at least one non-zero fee category.
  let count = 1;
  if (FEE_CATEGORIES.some((c) => FEE_BUCKET_BY_ID[c.id] === 'transaction-costs')) {
    count += 1;
  }
  if (FEE_CATEGORIES.some((c) => FEE_BUCKET_BY_ID[c.id] === 'platform-fee')) {
    count += 1;
  }
  return count;
}

describe('CostPieChart', () => {
  describe('rendering', () => {
    it('renders with data-testid cost-pie-chart', () => {
      render(<CostPieChart depositAmount={100} />);
      expect(screen.getByTestId(TEST_IDS.costPieChart)).toBeInTheDocument();
    });

    it('omits the fee slices when there are no fees (zero deposit)', () => {
      render(<CostPieChart depositAmount={0} />);
      expect(screen.getByTestId(TEST_IDS.costPieChart)).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.sliceTransactionCosts)).toBeNull();
      expect(screen.queryByTestId(TEST_IDS.slicePlatformFee)).toBeNull();
    });

    it('renders an SVG element', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      expect(container.querySelector('svg')).toBeInTheDocument();
    });

    it('does NOT render legend text', () => {
      render(<CostPieChart depositAmount={100} />);
      expect(screen.queryByText('Model usage')).not.toBeInTheDocument();
      expect(screen.queryByText('Storage')).not.toBeInTheDocument();
      expect(screen.queryByText('HushBox profit')).not.toBeInTheDocument();
      expect(screen.queryByText('AI provider overhead')).not.toBeInTheDocument();
      expect(screen.queryByText('Credit card processing')).not.toBeInTheDocument();
    });

    it('does NOT render center text with dollar amount', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const svg = container.querySelector('svg');
      expect(svg?.querySelector('text')).not.toBeInTheDocument();
    });
  });

  describe('pie slices', () => {
    it('renders one path per non-empty category group', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const paths = container.querySelectorAll('path');
      expect(paths.length).toBe(expectedSliceCount());
    });

    it('renders the Service Value slice (blue) at all rate values', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const slice = container.querySelector(`[data-testid="${TEST_IDS.sliceServiceValue}"]`);
      expect(slice).toBeInTheDocument();
      expect(slice).toHaveAttribute('fill', '#3b82f6');
    });

    it('renders the Transaction Costs slice (amber) iff at least one transaction fee has rate > 0', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const slice = container.querySelector(`[data-testid="${TEST_IDS.sliceTransactionCosts}"]`);
      const hasTransactionCosts = FEE_CATEGORIES.some(
        (c) => FEE_BUCKET_BY_ID[c.id] === 'transaction-costs'
      );
      if (hasTransactionCosts) {
        expect(slice).toBeInTheDocument();
        expect(slice).toHaveAttribute('fill', '#f59e0b');
      } else {
        expect(slice).not.toBeInTheDocument();
      }
    });

    it('renders the Platform Fee slice (brand red) iff the hushbox fee has rate > 0', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const slice = container.querySelector(`[data-testid="${TEST_IDS.slicePlatformFee}"]`);
      const hasPlatformFee = FEE_CATEGORIES.some((c) => FEE_BUCKET_BY_ID[c.id] === 'platform-fee');
      if (hasPlatformFee) {
        expect(slice).toBeInTheDocument();
        expect(slice).toHaveAttribute('fill', '#ec4755');
      } else {
        expect(slice).not.toBeInTheDocument();
      }
    });

    it('does not render a slice for any zero-rate fee category bucket', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const allTransactionRatesZero = ALL_FEE_CATEGORIES.filter(
        (c) => FEE_BUCKET_BY_ID[c.id] === 'transaction-costs'
      ).every((c) => c.rate === 0);
      const allPlatformRatesZero = ALL_FEE_CATEGORIES.filter(
        (c) => FEE_BUCKET_BY_ID[c.id] === 'platform-fee'
      ).every((c) => c.rate === 0);
      if (allTransactionRatesZero) {
        expect(
          container.querySelector(`[data-testid="${TEST_IDS.sliceTransactionCosts}"]`)
        ).not.toBeInTheDocument();
      }
      if (allPlatformRatesZero) {
        expect(
          container.querySelector(`[data-testid="${TEST_IDS.slicePlatformFee}"]`)
        ).not.toBeInTheDocument();
      }
    });
  });

  describe('donut style', () => {
    it('renders center hole for donut effect', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const centerHole = container.querySelector('circle');
      expect(centerHole).toBeInTheDocument();
    });
  });
});
