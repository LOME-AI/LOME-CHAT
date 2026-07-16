import * as React from 'react';
import {
  STORAGE_COST_PER_CHARACTER,
  FEE_BUCKET_BY_ID,
  FEE_CATEGORIES,
  TEST_IDS,
  type FeeBucketId,
} from '@hushbox/shared';

export interface CostPieChartProps {
  /** The deposit amount in USD */
  depositAmount: number;
  /** Estimated characters used (for storage fee calculation) */
  estimatedCharacters?: number;
}

interface PieSlice {
  label: string;
  value: number;
  color: string;
  testId: string;
}

const COLORS = {
  SERVICE_VALUE: '#3b82f6',
  TRANSACTION_COSTS: '#f59e0b',
  PLATFORM_FEE: '#ec4755',
};

interface ArcParams {
  cx: number;
  cy: number;
  radius: number;
  startAngle: number;
  endAngle: number;
}

function describeArc(params: ArcParams): string {
  const { cx, cy, radius, startAngle, endAngle } = params;
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return [
    'M',
    cx,
    cy,
    'L',
    start.x,
    start.y,
    'A',
    radius,
    radius,
    0,
    largeArcFlag,
    0,
    end.x,
    end.y,
    'Z',
  ].join(' ');
}

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number
): { x: number; y: number } {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function sumFeeValues(bucket: FeeBucketId, depositAmount: number): number {
  return FEE_CATEGORIES.filter((c) => FEE_BUCKET_BY_ID[c.id] === bucket).reduce(
    (sum, c) => sum + depositAmount * c.rate,
    0
  );
}

export function CostPieChart({
  depositAmount,
  estimatedCharacters = 1_000_000,
}: Readonly<CostPieChartProps>): React.JSX.Element {
  const totalFees = FEE_CATEGORIES.reduce((sum, c) => sum + depositAmount * c.rate, 0);
  const storageFee = estimatedCharacters * STORAGE_COST_PER_CHARACTER;
  const modelUsage = depositAmount - totalFees - storageFee;

  const transactionCosts = sumFeeValues('transaction-costs', depositAmount);
  const platformFee = sumFeeValues('platform-fee', depositAmount);
  const serviceValue = modelUsage + storageFee;

  const slices: PieSlice[] = [
    {
      label: 'Service Value',
      value: serviceValue,
      color: COLORS.SERVICE_VALUE,
      testId: TEST_IDS.sliceServiceValue,
    },
  ];
  if (transactionCosts > 0) {
    slices.push({
      label: 'Transaction Costs',
      value: transactionCosts,
      color: COLORS.TRANSACTION_COSTS,
      testId: TEST_IDS.sliceTransactionCosts,
    });
  }
  if (platformFee > 0) {
    slices.push({
      label: 'Platform Fee',
      value: platformFee,
      color: COLORS.PLATFORM_FEE,
      testId: TEST_IDS.slicePlatformFee,
    });
  }

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const cx = 100;
  const cy = 100;
  const radius = 80;

  let currentAngle = 0;

  return (
    <div data-testid={TEST_IDS.costPieChart} className="flex items-center justify-center">
      <svg width="240" height="240" viewBox="0 0 200 200" className="flex-shrink-0">
        {slices.map((slice) => {
          const sliceAngle = (slice.value / total) * 360;
          const startAngle = currentAngle;
          const endAngle = currentAngle + sliceAngle;
          currentAngle = endAngle;

          // Degenerate-slice guard. With the real fee catalog no slice is ever
          // narrower than 0.5°, so this branch is defensive only.
          /* v8 ignore next */
          if (sliceAngle < 0.5) return null;

          return (
            <path
              key={slice.testId}
              data-testid={slice.testId}
              d={describeArc({ cx, cy, radius, startAngle, endAngle })}
              fill={slice.color}
              stroke="hsl(var(--background))"
              strokeWidth="2"
            />
          );
        })}
        <circle cx={cx} cy={cy} r={40} fill="transparent" />
      </svg>
    </div>
  );
}
