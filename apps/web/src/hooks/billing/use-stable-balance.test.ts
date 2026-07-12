import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useStableBalance } from '@/hooks/billing/use-stable-balance';

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: vi.fn(),
}));

import { useBalance } from '@/hooks/billing/billing';
import { useStability } from '@/providers/stability-provider';

const mockedUseBalance = vi.mocked(useBalance);
const mockedUseStability = vi.mocked(useStability);

// Purchased balance as a NanoUSD wire string ($1 = 1_000_000_000 nano).
function bal(purchasedNanoUsd: string): { purchased: { balanceNanoUsd: string } } {
  return { purchased: { balanceNanoUsd: purchasedNanoUsd } };
}

describe('useStableBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isStable', () => {
    it('returns isBalanceStable from stability provider', () => {
      mockedUseBalance.mockReturnValue({
        data: bal('10000000000'),
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.isStable).toBe(true);
    });

    it('returns false when balance is not stable', () => {
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.isStable).toBe(false);
    });
  });

  describe('isStable with explicit enabled (billing portal)', () => {
    it('is false when enabled is true but data has not loaded yet', () => {
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance({ enabled: true }));

      expect(result.current.isStable).toBe(false);
    });

    it('is true when enabled is true and data has loaded', () => {
      mockedUseBalance.mockReturnValue({
        data: bal('10000000000000'),
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance({ enabled: true }));

      expect(result.current.isStable).toBe(true);
    });

    it('delegates to stability provider when enabled is not set', () => {
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.isStable).toBe(true);
    });
  });

  describe('displayBalance', () => {
    it('returns balance from data when available', () => {
      mockedUseBalance.mockReturnValue({
        data: bal('25500000000'),
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.displayBalance).toBe('25.50');
    });

    it('returns "0" when no data available', () => {
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.displayBalance).toBe('0');
    });

    it('returns "0" when data is null', () => {
      mockedUseBalance.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.displayBalance).toBe('0');
    });
  });

  describe('passes through useBalance properties', () => {
    it('returns data from useBalance', () => {
      const balanceData = bal('100000000000');
      mockedUseBalance.mockReturnValue({
        data: balanceData,
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.data).toEqual(balanceData);
    });

    it('returns isPending from useBalance', () => {
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.isPending).toBe(true);
    });
  });
});
