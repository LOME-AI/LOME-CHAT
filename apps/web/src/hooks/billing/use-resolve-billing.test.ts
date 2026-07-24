import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useResolveBilling,
  type UseResolveBillingInput,
} from '@/hooks/billing/use-resolve-billing';

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/hooks/billing/use-spendable', () => ({
  useSpendable: vi.fn(),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: vi.fn(() => ({
    isAuthStable: true,
    isBalanceStable: true,
    isAppStable: true,
  })),
}));

import { useBalance } from '@/hooks/billing/billing';
import { useSpendable } from '@/hooks/billing/use-spendable';
import type { UseQueryResult } from '@tanstack/react-query';
import type { GetBalanceResponse, GetSpendableResponse } from '@hushbox/shared';

const mockUseBalance = vi.mocked(useBalance);
const mockUseSpendable = vi.mocked(useSpendable);

function spendable(spendableNanoUsd: string): UseQueryResult<GetSpendableResponse> {
  return {
    data: { spendableNanoUsd, heldNanoUsd: '0' },
    isPending: false,
  } as UseQueryResult<GetSpendableResponse>;
}

// Balance wire shape: purchased (negative-capable) + free-tier allowance, all
// NanoUSD strings. $1 = 1_000_000_000 nano.
function balance(purchasedNanoUsd: string, remainingNanoUsd: string): GetBalanceResponse {
  return {
    purchased: { balanceNanoUsd: purchasedNanoUsd },
    free: { balanceNanoUsd: '0' },
    allowance: {
      day: '2026-07-11',
      limitNanoUsd: '5000000000',
      spentNanoUsd: '0',
      remainingNanoUsd,
    },
  };
}

describe('useResolveBilling', () => {
  const defaultInput: UseResolveBillingInput = {
    estimatedMinimumCostNanoUsd: 40_000_000n, // 4¢
    isPremiumModel: false,
    isAuthenticated: true,
  };

  beforeEach(() => {
    mockUseBalance.mockReturnValue({
      data: balance('10000000000', '5000000000'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
    // Served spendable: $10 balance + 50¢ baked cushion.
    mockUseSpendable.mockReturnValue(spendable('10500000000'));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns personal_balance for paid user with sufficient balance', () => {
    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current.fundingSource).toBe('personal_balance');
  });

  it('returns free_allowance for free tier user', () => {
    mockUseBalance.mockReturnValue({
      data: balance('0', '5000000000'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);

    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current.fundingSource).toBe('free_allowance');
  });

  it('returns trial_fixed for unauthenticated user within cost cap', () => {
    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        isAuthenticated: false,
        estimatedMinimumCostNanoUsd: 10_000_000n, // Within MAX_TRIAL_MESSAGE_COST_CENTS (1 cent)
      })
    );

    expect(result.current.fundingSource).toBe('trial_fixed');
  });

  it('returns denied with premium_requires_balance for free user with premium model', () => {
    mockUseBalance.mockReturnValue({
      data: balance('0', '5000000000'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);

    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        isPremiumModel: true,
      })
    );

    expect(result.current.fundingSource).toBe('denied');
    if (result.current.fundingSource === 'denied') {
      expect(result.current.reason).toBe('premium_requires_balance');
    }
  });

  it('returns denied with insufficient_balance for paid user with too-low served spendable', () => {
    // Small positive balance → paid tier; the SERVED spendable (already
    // cushioned) is what the estimate compares against.
    mockUseBalance.mockReturnValue({
      data: balance('10000000', '0'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
    mockUseSpendable.mockReturnValue(spendable('510000000'));

    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        estimatedMinimumCostNanoUsd: 1_000_000_000_000n, // Far exceeds the served spendable
      })
    );

    expect(result.current.fundingSource).toBe('denied');
    if (result.current.fundingSource === 'denied') {
      expect(result.current.reason).toBe('insufficient_balance');
    }
  });

  it('returns owner_balance when group budget is available', () => {
    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        group: {
          effectiveRemainingNanoUsd: 5_000_000_000n,
          ownerBalanceNanoUsd: 50_000_000_000n,
        },
      })
    );

    expect(result.current.fundingSource).toBe('owner_balance');
  });

  it('falls through to personal when group budget is exhausted', () => {
    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        group: {
          effectiveRemainingNanoUsd: 0n,
          ownerBalanceNanoUsd: 50_000_000_000n,
        },
      })
    );

    // zero effective remaining → falls through to personal
    expect(result.current.fundingSource).toBe('personal_balance');
  });

  it('denies with insufficient_balance when the group owner balance is negative', () => {
    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        group: {
          effectiveRemainingNanoUsd: 5_000_000_000n,
          ownerBalanceNanoUsd: -1_000_000_000n,
        },
      })
    );

    expect(result.current.fundingSource).toBe('denied');
    if (result.current.fundingSource === 'denied') {
      expect(result.current.reason).toBe('insufficient_balance');
    }
  });

  it('denies with insufficient_balance when the caller purchased balance is negative (solo)', () => {
    // The hard block reads the RAW served balance — the cushioned spendable is
    // positive here, and must not override the negative-balance denial.
    mockUseBalance.mockReturnValue({
      data: balance('-2000000000', '0'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
    mockUseSpendable.mockReturnValue(spendable('300000000'));

    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current.fundingSource).toBe('denied');
    if (result.current.fundingSource === 'denied') {
      expect(result.current.reason).toBe('insufficient_balance');
    }
  });

  it('treats an unloaded served spendable as zero (paid send denies until it arrives)', () => {
    // No served number yet → the affordability compare sees 0n and denies;
    // the composer's loading gate (useBudgetCalculation) blocks the flash.
    mockUseSpendable.mockReturnValue({
      data: undefined,
      isPending: true,
    } as UseQueryResult<GetSpendableResponse>);

    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current).toEqual({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });

  it('memoizes result when inputs are stable', () => {
    const { result, rerender } = renderHook(() => useResolveBilling(defaultInput));

    const first = result.current;
    rerender();
    const second = result.current;

    expect(first).toBe(second);
  });
});
