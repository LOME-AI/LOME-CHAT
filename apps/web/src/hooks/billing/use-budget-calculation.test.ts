import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBalance } from '@/test-utils/balance-fixture';
import { renderHook, act } from '@testing-library/react';
import {
  getEffectiveBalanceNano,
  type GetBalanceResponse,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
} from '@hushbox/shared';
import {
  estimateTokensForTier,
  outputCharsPerTokenForTier,
} from '@hushbox/shared/affordability/estimate/pre-adapters';
import { priceRequest } from '@hushbox/shared/affordability/estimate/price-request';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '@hushbox/shared/affordability/estimate/reasoning-plan';
import { affordability } from '@hushbox/shared/affordability/estimate/reducers';
import { WEB_SEARCH_RESERVATION_NANO_PER_MODEL } from '@hushbox/shared/affordability/estimate/search-reservation';
import { useBudgetCalculation } from '@/hooks/billing/use-budget-calculation';
import * as billingHooks from '@/hooks/billing/billing';
import { useSpendable } from '@/hooks/billing/use-spendable';
import type { UseQueryResult } from '@tanstack/react-query';
import type { GetSpendableResponse } from '@hushbox/shared';

const { mockUseStability, mockLinkGuestKey } = vi.hoisted(() => ({
  mockUseStability: vi.fn(),
  mockLinkGuestKey: { current: null as string | null },
}));

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: vi.fn(),
}));

// One controllable fact drives both the sender's tier and whether a funding
// door exists, exactly as production does — a guest credential is the only
// thing that makes an unauthenticated caller a payer's reader.
vi.mock('@/lib/link-guest-auth', () => ({
  getLinkGuestAuth: () => mockLinkGuestKey.current,
}));

vi.mock('@/hooks/billing/use-spendable', () => ({
  useSpendable: vi.fn(),
  // The predicate's own behaviour is pinned in `use-spendable.test.ts`; here it
  // is a double stating whether this caller has a funding door at all. It
  // mirrors the real rule rather than only its authenticated arm, because a
  // link guest inside a conversation has a door too and the gate under test is
  // exactly what a door-holder without a snapshot must do.
  hasServedFunding: (isAuthenticated: boolean, conversationId: string | null) =>
    isAuthenticated || (mockLinkGuestKey.current !== null && conversationId !== null),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: mockUseStability,
}));

const mockUseBalance = vi.mocked(billingHooks.useBalance);
const mockUseSpendable = vi.mocked(useSpendable);

/** A settled read that produced no snapshot — the trial's permanent state, since it has no funding door to read. */
function noSpendable(): UseQueryResult<GetSpendableResponse> {
  return { data: undefined, isPending: false } as UseQueryResult<GetSpendableResponse>;
}

/** Served funding snapshot fixture, as GET /billing/spendable returns it. */
function makeSpendable(
  spendableNanoUsd: string,
  payer: GetSpendableResponse['payer'] = 'self',
  payerTier: GetSpendableResponse['payerTier'] = 'paid'
): UseQueryResult<GetSpendableResponse> {
  return {
    data: { spendableNanoUsd, heldNanoUsd: '0', payerTier, payer },
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
    mockLinkGuestKey.current = null;
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
      // No endpoint exists for a trial caller, so no snapshot names a payer.
      mockUseSpendable.mockReturnValue(noSpendable());

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
      mockUseSpendable.mockReturnValue(makeSpendable('500000000', 'self', 'free'));

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
      mockUseSpendable.mockReturnValue(noSpendable());
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
      mockUseSpendable.mockReturnValue(makeSpendable('10500000000'));
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

  describe("the payer's numbers, not the sender's (BILLING §Group Funding 1)", () => {
    /** A free-tier sender: zero purchased balance, zero daily allowance left. */
    function freeTierSender(): void {
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
    }

    it('asks the served read for the payer of the conversation it composes in', () => {
      renderHook(() => useBudgetCalculation({ ...defaultInput, conversationId: 'conv-1' }));

      expect(mockUseSpendable).toHaveBeenCalledWith('conv-1');
    });

    it("estimates input tokens at the PAYER's ratio when the owner funds the turn", () => {
      freeTierSender();
      mockUseSpendable.mockReturnValue(makeSpendable('4000000000', 'owner', 'paid'));

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          conversationId: 'conv-1',
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // The paid ratio is 4 chars/token; the sender's own free-tier ratio is 2,
      // so a sender-scoped read would double this count.
      expect(result.current.estimatedInputTokens).toBe(estimateTokensForTier('paid', 4000));
    });

    it("solves affordability against the PAYER's remaining, not the sender's allowance", () => {
      freeTierSender();
      const servedSpendable = 4_000_000_000n;
      mockUseSpendable.mockReturnValue(makeSpendable(servedSpendable.toString(), 'owner', 'paid'));

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          conversationId: 'conv-1',
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      const manifest = priceRequest({
        models: [{ pricing: { inputPerToken: 10_000n, outputPerToken: 30_000n } }],
        inputTokens: BigInt(estimateTokensForTier('paid', 4000)),
        inputChars: 4000,
        outputCharsPerToken: outputCharsPerTokenForTier('paid'),
      });
      if (!manifest.ok) throw new Error('unpriceable test request');
      expect(result.current.maxOutputTokens).toBe(
        Number(affordability(manifest.value, servedSpendable).maxOutputTokens)
      );
    });

    it("keeps the sender's own tier once the group allowance falls through", () => {
      freeTierSender();
      // Fall-through: the server names the sender as payer at their own tier.
      mockUseSpendable.mockReturnValue(makeSpendable('500000000', 'self', 'free'));

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          conversationId: 'conv-1',
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.estimatedInputTokens).toBe(estimateTokensForTier('free', 4000));
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

    it('gates free-tier affordability on the served allowance', () => {
      // A depleted daily allowance refuses. The served figure IS the allowance
      // remaining for a free payer, so there is nothing else to consult.
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseSpendable.mockReturnValue(makeSpendable('0', 'self', 'free'));

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('sizes a free-tier turn on the HOLD-AWARE served allowance, not the balance endpoint', () => {
      // The two endpoints disagree by design while a run is in flight:
      // /billing/balance reports the day's allowance hold-blind (50¢), while
      // /billing/spendable subtracts the 40¢ this payer's own run reserved and
      // serves 10¢ — the figure admission gates on. Sizing from the hold-blind
      // number offers a longer answer than the payer can currently start.
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '500000000'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseSpendable.mockReturnValue(makeSpendable('100000000', 'self', 'free'));

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      const request = {
        models: [{ pricing: { inputPerToken: 10_000n, outputPerToken: 30_000n } }],
        inputTokens: BigInt(estimateTokensForTier('free', defaultInput.promptCharacterCount)),
        inputChars: defaultInput.promptCharacterCount,
        outputCharsPerToken: outputCharsPerTokenForTier('free'),
      };
      const manifest = priceRequest(request);
      if (!manifest.ok) throw new Error('fixture must price');

      expect(result.current.maxOutputTokens).toBe(
        Number(affordability(manifest.value, 100_000_000n).maxOutputTokens)
      );
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

  describe('a funding read that failed is not a served figure', () => {
    it('keeps a link guest loading when its funding read settled with no snapshot', () => {
      // A FAILED read, not a pending one: the query has settled (`isPending`
      // false) and produced nothing. The guest holds a door, so the trial's
      // absent-forever case does not apply — there is a payer figure, it just
      // has not arrived.
      mockLinkGuestKey.current = 'link-public-key';
      mockUseSpendable.mockReturnValue({
        data: undefined,
        isPending: false,
      } as UseQueryResult<GetSpendableResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          isAuthenticated: false,
          conversationId: 'conv-1',
        })
      );

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
