import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBalance } from '@/test-utils/balance-fixture';
import { renderHook, act } from '@testing-library/react';
import {
  affordability,
  estimateTokensForTier,
  getEffectiveBalanceNano,
  outputCharsPerTokenForTier,
  priceRequest,
  WEB_SEARCH_RESERVATION_NANO_PER_MODEL,
  type GetBalanceResponse,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  REASONING_BUDGET_TOKENS_BY_EFFORT,
} from '@hushbox/shared';
import { useBudgetCalculation } from '@/hooks/billing/use-budget-calculation';
import * as billingHooks from '@/hooks/billing/billing';
import { useSpendable } from '@/hooks/billing/use-spendable';
import type { UseQueryResult } from '@tanstack/react-query';
import type { GetSpendableResponse } from '@hushbox/shared';

const { mockUseStability } = vi.hoisted(() => ({
  mockUseStability: vi.fn(),
}));

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/hooks/billing/use-spendable', () => ({
  useSpendable: vi.fn(),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: mockUseStability,
}));

const mockUseBalance = vi.mocked(billingHooks.useBalance);
const mockUseSpendable = vi.mocked(useSpendable);

/** Served spendable fixture: cushion- and hold-aware, as GET /billing/spendable returns it. */
function makeSpendable(spendableNanoUsd: string): UseQueryResult<GetSpendableResponse> {
  return {
    data: { spendableNanoUsd, heldNanoUsd: '0' },
    isPending: false,
  } as UseQueryResult<GetSpendableResponse>;
}

describe('useBudgetCalculation', () => {
  const defaultInput = {
    promptCharacterCount: 1000,
    // BASE (pre-markup) nano rates: $0.00001 input, $0.00003 output per token.
    models: [
      {
        inputPerTokenNano: 10_000n,
        outputPerTokenNano: 30_000n,
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
    mockUseSpendable.mockReturnValue(makeSpendable('10500000000'));
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

      // Initial: trial tier, low maxOutputTokens (the stale state that flashes).
      expect(result.current.maxOutputTokens).toBeLessThan(LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD);

      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '5000000000'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      // Rerender WITHOUT advancing timers — debounce has NOT fired.
      rerender();

      expect(result.current.maxOutputTokens).toBeGreaterThan(LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD);
    });

    it('does not loop when the balance query returns a fresh data object every render', () => {
      mockUseBalance.mockImplementation(
        () =>
          ({
            data: makeBalance('10000000000', '5000000000'),
            isPending: false,
          }) as UseQueryResult<GetBalanceResponse>
      );

      const { rerender } = renderHook(() => useBudgetCalculation(defaultInput));

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

      rerender({ count: 2000 });

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

      rerender({ count: 5000 });

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
          promptCharacterCount: 4000,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

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

    it('returns zero maxOutputTokens when the served spendable is insufficient', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      // Free tier (zero balance): allowance 0 is the gate; spendable is unused.
      mockUseSpendable.mockReturnValue(makeSpendable('500000000'));

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 100_000,
          models: [
            {
              inputPerTokenNano: 1_000_000n,
              outputPerTokenNano: 30_000n,
              contextLength: 128_000,
            },
          ],
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('returns zeroed result when no models are selected', () => {
      const { result } = renderHook(() => useBudgetCalculation({ ...defaultInput, models: [] }));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(0);
      expect(result.current.estimatedMinimumCostNanoUsd).toBe(0n);
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
          models: [{ ...defaultInput.models[0]!, contextLength: 10_000 }],
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // currentUsage = capacityInputTokens (4000/4=1000) + MINIMUM_OUTPUT_TOKENS (1000)
      // capacityPercent = 2000 / 10000 * 100 = 20%
      expect(result.current.capacityPercent).toBe(20);
    });

    it('returns estimatedMinimumCostNanoUsd in exact nano-USD (BASE rates marked up + storage)', () => {
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

      // Paid, 4000 chars → 1000 input tokens; outputCharsPerToken = 2 (paid, inverted).
      // Rates are billable at ingestion — the estimator is a pure sum:
      // fixed = 1000 × 10_000 + 4000 × 300 = 10_000_000 + 1_200_000
      // varRate = 30_000 + 2 × 300 = 30_600
      // minCost = fixed + 1000 × varRate
      const fixed = 1000n * 10_000n + 4000n * 300n;
      const variableRate = 30_000n + 2n * 300n;
      const minCostNano = fixed + 1000n * variableRate;
      expect(result.current.estimatedMinimumCostNanoUsd).toBe(minCostNano);
    });
  });

  describe('served spendable as THE paid affordability input', () => {
    it('gates paid affordability on the served spendable, not the raw balance', () => {
      // Raw balance $10 but served spendable 0 (e.g. holds ate it): affordability
      // must refuse — the client never re-derives spendable from the balance.
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseSpendable.mockReturnValue(makeSpendable('0'));

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('funds exactly the served spendable — the baked cushion is never re-added', () => {
      // The served number already includes the $0.50 cushion exactly once.
      // Expected tokens = the shared affordability solve at EXACTLY the served
      // figure; a double-cushion bug would fund strictly more.
      mockUseBalance.mockReturnValue({
        data: makeBalance('1000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      const servedSpendable = 1_500_000_000n;
      mockUseSpendable.mockReturnValue(makeSpendable(servedSpendable.toString()));

      const { result } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, promptCharacterCount: 4000 })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      const request = {
        models: [{ pricing: { inputPerToken: 10_000n, outputPerToken: 30_000n } }],
        inputTokens: BigInt(estimateTokensForTier('paid', 4000)),
        inputChars: 4000,
        outputCharsPerToken: outputCharsPerTokenForTier('paid'),
      };
      const manifest = priceRequest(request);
      if (!manifest.ok) throw new Error('unpriceable test request');
      const expected = affordability(manifest.value, servedSpendable);
      expect(result.current.maxOutputTokens).toBe(Number(expected.maxOutputTokens));
      expect(
        Number(affordability(manifest.value, servedSpendable + 500_000_000n).maxOutputTokens)
      ).toBeGreaterThan(result.current.maxOutputTokens);
    });

    it('gates free-tier affordability on the served allowance, never the cushioned spendable', () => {
      // Zero-balance user: the purchased-wallet spendable is +$0.50 (cushion),
      // but a depleted daily allowance must still refuse.
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseSpendable.mockReturnValue(makeSpendable('500000000'));

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('keeps the client-side fixed arm for unauthenticated users (no endpoint exists)', () => {
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseSpendable.mockReturnValue({
        data: undefined,
        isPending: false,
      } as UseQueryResult<GetSpendableResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, isAuthenticated: false })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Exactly the shared trial fixed-1¢ solve — no served number involved.
      const request = {
        models: [{ pricing: { inputPerToken: 10_000n, outputPerToken: 30_000n } }],
        inputTokens: BigInt(estimateTokensForTier('trial', defaultInput.promptCharacterCount)),
        inputChars: defaultInput.promptCharacterCount,
        outputCharsPerToken: outputCharsPerTokenForTier('trial'),
      };
      const manifest = priceRequest(request);
      if (!manifest.ok) throw new Error('unpriceable test request');
      const expected = affordability(manifest.value, getEffectiveBalanceNano('trial', 0n, 0n));
      expect(result.current.maxOutputTokens).toBe(Number(expected.maxOutputTokens));
      expect(result.current.estimatedMinimumCostNanoUsd).toBe(expected.minCostNano);
    });

    it('reports loading while the served spendable is still pending for an authenticated user', () => {
      mockUseSpendable.mockReturnValue({
        data: undefined,
        isPending: true,
      } as UseQueryResult<GetSpendableResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isBalanceLoading).toBe(true);
    });
  });

  describe('web search cost', () => {
    it('adds the core web-search reservation when webSearch is enabled', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result: withoutSearch } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, promptCharacterCount: 4000 })
      );
      const { result: withSearch } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, promptCharacterCount: 4000, webSearch: true })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // The reservation is a marked-up fixed line item, one per model — exact bigint.
      expect(withSearch.current.estimatedMinimumCostNanoUsd).toBe(
        withoutSearch.current.estimatedMinimumCostNanoUsd + WEB_SEARCH_RESERVATION_NANO_PER_MODEL
      );
    });

    it('omits the web-search reservation by default', () => {
      const { result } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, promptCharacterCount: 4000 })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      const fixed = 1000n * 10_000n + 4000n * 300n;
      const variableRate = 30_000n + 2n * 300n;
      const minCostNano = fixed + 1000n * variableRate;
      expect(result.current.estimatedMinimumCostNanoUsd).toBe(minCostNano);
    });
  });

  describe('reasoning budget surcharge', () => {
    const estimateFor = (reasoningBudgetTokens?: number): bigint => {
      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          ...(reasoningBudgetTokens !== undefined && { reasoningBudgetTokens }),
        })
      );
      act(() => {
        vi.advanceTimersByTime(200);
      });
      return result.current.estimatedMinimumCostNanoUsd;
    };

    it('prices a larger reasoning budget strictly above a smaller one', () => {
      expect(estimateFor(REASONING_BUDGET_TOKENS_BY_EFFORT.high)).toBeGreaterThan(
        estimateFor(REASONING_BUDGET_TOKENS_BY_EFFORT.low)
      );
    });

    it('prices any reasoning budget strictly above a reasoning-free turn', () => {
      expect(estimateFor(REASONING_BUDGET_TOKENS_BY_EFFORT.low)).toBeGreaterThan(estimateFor());
    });

    it('prices a zero reasoning budget identically to an absent one', () => {
      expect(estimateFor(0)).toBe(estimateFor());
    });

    it('adds exactly B times the effective per-output-token rate to the minimum cost', () => {
      // The same effective rate `affordability` prices with: the billable
      // model output rate as-is plus the raw output-storage rate (paid tier:
      // 2 chars/token at 300 nano/char) — no fee math client-side.
      const variableRate = 30_000n + 2n * 300n;
      const budget = REASONING_BUDGET_TOKENS_BY_EFFORT.medium;
      expect(estimateFor(budget)).toBe(estimateFor() + BigInt(budget) * variableRate);
    });
  });
});
