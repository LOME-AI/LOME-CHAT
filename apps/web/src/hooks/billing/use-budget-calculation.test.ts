import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBalance } from '@/test-utils/balance-fixture';
import { renderHook, act } from '@testing-library/react';
import { type GetBalanceResponse, LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD } from '@hushbox/shared';
import { useBudgetCalculation } from '@/hooks/billing/use-budget-calculation';
import * as billingHooks from '@/hooks/billing/billing';
import type { UseQueryResult } from '@tanstack/react-query';

const { mockUseStability } = vi.hoisted(() => ({
  mockUseStability: vi.fn(),
}));

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: mockUseStability,
}));

const mockUseBalance = vi.mocked(billingHooks.useBalance);

describe('useBudgetCalculation', () => {
  const defaultInput = {
    promptCharacterCount: 1000,
    models: [
      {
        modelInputPricePerToken: 0.000_01,
        modelOutputPricePerToken: 0.000_03,
        contextLength: 128_000,
      },
    ],
    isAuthenticated: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockUseBalance.mockReturnValue({
      data: makeBalance('10000000000', '5000000000'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
    mockUseStability.mockReturnValue({
      isAuthStable: true,
      isBalanceStable: true,
      isAppStable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns math result before debounce completes', () => {
      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      expect(result.current.maxOutputTokens).toBeGreaterThan(0);
      expect(result.current.estimatedInputTokens).toBeGreaterThan(0);
      expect(result.current.capacityPercent).toBeGreaterThanOrEqual(0);
    });
  });

  describe('tier determination', () => {
    it('uses conservative token estimation for unauthenticated (trial) user', () => {
      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          isAuthenticated: false,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Trial tier uses 2 chars/token → 4000/2 = 2000 tokens
      expect(result.current.estimatedInputTokens).toBe(2000);
    });

    it('uses standard token estimation for authenticated paid user', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Paid tier uses 4 chars/token → 4000/4 = 1000 tokens
      expect(result.current.estimatedInputTokens).toBe(1000);
    });

    it('treats authenticated user with zero balance as free tier', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '5000000000'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Free tier uses 2 chars/token → 4000/2 = 2000 tokens
      expect(result.current.estimatedInputTokens).toBe(2000);
    });

    it('sets isBalanceLoading true when authenticated and balance is not stable', () => {
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isBalanceLoading).toBe(true);
    });

    it('sets isBalanceLoading false when not authenticated', () => {
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          isAuthenticated: false,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isBalanceLoading).toBe(false);
    });

    it('sets isBalanceLoading false when balance is stable', () => {
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '5000000000'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isBalanceLoading).toBe(false);
    });
  });

  describe('synchronous tier flush', () => {
    it('synchronously updates result when balance data loads without waiting for debounce', () => {
      // Start with no balance data (authenticated but balance not yet loaded → trial tier)
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });

      const { result, rerender } = renderHook(() => useBudgetCalculation(defaultInput));

      // Initial: trial tier, low maxOutputTokens (this is the stale state that causes the flash)
      expect(result.current.maxOutputTokens).toBeLessThan(LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD);

      // Simulate balance data arriving (same render cycle as stability changing)
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '5000000000'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      // Rerender WITHOUT advancing timers — debounce has NOT fired
      rerender();

      // maxOutputTokens must reflect paid tier IMMEDIATELY (no 150ms lag)
      // This prevents the "Low Balance" notification flash
      expect(result.current.maxOutputTokens).toBeGreaterThan(LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD);
    });

    it('does not loop when the balance query returns a fresh data object every render', () => {
      // Access-revoked flows (leave/remove/decline) repeatedly invalidate the
      // balance query, so `useBalance().data` is a new object reference on each
      // render even when the values are identical. The synchronous tier flush
      // must compare tier values, not the `tierInfo` reference — a reference
      // compare setStates on every render once a re-render starts, and React
      // throws "Maximum update depth exceeded".
      mockUseBalance.mockImplementation(
        () =>
          ({
            data: makeBalance('10000000000', '5000000000'),
            isPending: false,
          }) as UseQueryResult<GetBalanceResponse>
      );

      const { rerender } = renderHook(() => useBudgetCalculation(defaultInput));

      // A re-render (e.g. triggered by a balance refetch) must not ignite an
      // unbounded render loop just because the data reference changed.
      expect(() => {
        rerender();
      }).not.toThrow();
    });
  });

  describe('debouncing', () => {
    it('debounces calculation by 150ms', () => {
      const { result, rerender } = renderHook(
        ({ count }: { count: number }) =>
          useBudgetCalculation({
            ...defaultInput,
            promptCharacterCount: count,
          }),
        { initialProps: { count: 1000 } }
      );

      const initialResult = result.current;

      // Rerender with new value before debounce completes
      rerender({ count: 2000 });

      // Result should still be initial values (debounce not complete)
      expect(result.current).toStrictEqual(initialResult);

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.estimatedInputTokens).toBeGreaterThan(0);
    });

    it('still debounces when only promptCharacterCount changes', () => {
      const { result, rerender } = renderHook(
        ({ count }: { count: number }) =>
          useBudgetCalculation({
            ...defaultInput,
            promptCharacterCount: count,
          }),
        { initialProps: { count: 1000 } }
      );

      const initialTokens = result.current.estimatedInputTokens;

      // Change character count (simulates typing) — tier unchanged
      rerender({ count: 5000 });

      // Without advancing timer, result should NOT have updated (debounce in effect)
      expect(result.current.estimatedInputTokens).toBe(initialTokens);

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.estimatedInputTokens).toBeGreaterThan(initialTokens);
    });
  });

  describe('budget calculation', () => {
    it('calculates input tokens based on character count', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000, // 4000 chars at 4 chars/token = 1000 tokens
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Paid tier uses 4 chars/token
      expect(result.current.estimatedInputTokens).toBe(1000);
    });

    it('returns positive maxOutputTokens when balance covers minimum cost', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBeGreaterThan(0);
    });

    it('returns zero maxOutputTokens when balance is insufficient', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 100_000, // Large message
          models: [
            {
              modelInputPricePerToken: 0.001,
              modelOutputPricePerToken: 0.000_03,
              contextLength: 128_000,
            },
          ], // Expensive model
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('calculates capacity percentage correctly', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          models: [{ ...defaultInput.models[0]!, contextLength: 10_000 }], // Small context for test
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // currentUsage = capacityInputTokens (4000/4=1000) + MINIMUM_OUTPUT_TOKENS (1000)
      // capacityPercent = 2000 / 10000 * 100 = 20%
      expect(result.current.capacityPercent).toBe(20);
    });

    it('returns estimatedMinimumCost in dollars', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // 4000 chars / 4 chars per token (paid) = 1000 input tokens
      // inputStorageCost = 4000 * 0.0000003 = 0.0012
      // estimatedInputCost = 1000 * 0.00001 + 0.0012 = 0.0112
      // Output storage: paid tier → CONSERVATIVE (2) chars/tok (optimistic, inverted from input)
      // outputCostPerToken = 0.00003 + 2 * 0.0000003 = 0.0000306
      // minimumOutputCost = 1000 * 0.0000306 = 0.0306
      // estimatedMinimumCost = 0.0112 + 0.0306 = 0.0418
      expect(result.current.estimatedMinimumCost).toBeCloseTo(0.0418, 5);
    });
  });

  describe('web search cost', () => {
    it('includes webSearchCost in estimated input cost', () => {
      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          webSearchCost: 0.005,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Without search: estimatedInputCost = 1000 * 0.00001 + 0.0012 = 0.0112
      // With search: estimatedInputCost = 0.0112 + 0.005 = 0.0162
      // estimatedMinimumCost = 0.0162 + 0.0306 = 0.0468
      expect(result.current.estimatedMinimumCost).toBeCloseTo(0.0468, 5);
    });

    it('defaults webSearchCost to 0 when omitted', () => {
      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.estimatedMinimumCost).toBeCloseTo(0.0418, 5);
    });
  });
});
