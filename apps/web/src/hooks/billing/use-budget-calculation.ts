import * as React from 'react';
import {
  affordability,
  computePromptCapacity,
  estimateTokensForTier,
  getEffectiveBalanceNano,
  outputCharsPerTokenForTier,
  priceRequest,
  NANO_USD_PER_DOLLAR,
  type BillableRequest,
  type UserTier,
} from '@hushbox/shared';

import { useStability } from '@/providers/stability-provider';
import { useUserTierInfo } from '@/hooks/billing/use-user-tier-info.js';
import { useBalance } from '@/hooks/billing/billing.js';

const DOLLARS_PER_NANO = Number(NANO_USD_PER_DOLLAR);

const DEBOUNCE_MS = 150;

export interface BudgetModelPricing {
  /** BASE (pre-markup) nano-USD input rate per token. */
  inputPerTokenNano: bigint;
  /** BASE (pre-markup) nano-USD output rate per token. */
  outputPerTokenNano: bigint;
  /** Model's maximum context length in tokens. */
  contextLength: number;
}

export interface UseBudgetCalculationInput {
  /** Character count for: system prompt + history + current message */
  promptCharacterCount: number;
  /** Models to include in budget calculation (BASE nano rates). */
  models: BudgetModelPricing[];
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Whether the web-search tool is enabled (adds the core's worst-case reservation). */
  webSearch?: boolean;
}

export interface BudgetCalculationResult {
  /** Maximum output tokens the effective balance can fund (0 when insufficient). */
  maxOutputTokens: number;
  /** Estimated input tokens based on tier. */
  estimatedInputTokens: number;
  /** Estimated minimum total cost (input + minimum output), in dollars. */
  estimatedMinimumCost: number;
  /** Current context usage in tokens (input + minimum output reserve). */
  currentUsage: number;
  /** Capacity percentage (currentUsage / modelContextLength * 100). */
  capacityPercent: number;
}

const ZERO_RESULT: BudgetCalculationResult = {
  maxOutputTokens: 0,
  estimatedInputTokens: 0,
  estimatedMinimumCost: 0,
  currentUsage: 0,
  capacityPercent: 0,
};

interface TierBalance {
  tier: UserTier;
  purchasedNanoUsd: bigint;
  freeAllowanceNanoUsd: bigint;
}

/**
 * Build the input-driven {@link BillableRequest} the shared core prices. Char→token
 * conversion and output-storage inversion live in the shared pre-adapters so the
 * request the client assembles is the identical input the server would stamp.
 */
function buildRequest(input: UseBudgetCalculationInput, tier: UserTier): BillableRequest {
  return {
    models: input.models.map((m) => ({
      pricing: { inputPerToken: m.inputPerTokenNano, outputPerToken: m.outputPerTokenNano },
    })),
    inputTokens: BigInt(estimateTokensForTier(tier, input.promptCharacterCount)),
    inputChars: input.promptCharacterCount,
    outputCharsPerToken: outputCharsPerTokenForTier(tier),
    ...(input.webSearch === true && { webSearch: true }),
  };
}

/**
 * Derive the budget math from the shared cost core: price the request into a
 * nano manifest, then solve affordability against the tier's effective balance.
 * The same core the server's turn-level estimate uses, so identical inputs
 * produce identical nano — parity by construction. Money stays bigint until the
 * final nano→dollar conversion for display.
 */
function computeBudget(
  input: UseBudgetCalculationInput,
  balance: TierBalance
): BudgetCalculationResult {
  if (input.models.length === 0) return ZERO_RESULT;

  const request = buildRequest(input, balance.tier);
  const manifest = priceRequest(request);
  /* v8 ignore next 2 -- unreachable: models always carry bigint rates and the token/char inputs are valid, so the text-path priceRequest never fails */
  if (!manifest.ok) return ZERO_RESULT;

  const effectiveBalanceNano = getEffectiveBalanceNano(
    balance.tier,
    balance.purchasedNanoUsd,
    balance.freeAllowanceNanoUsd
  );
  const afford = affordability(manifest.value, effectiveBalanceNano);

  const modelContextLength = Math.min(...input.models.map((m) => m.contextLength));
  const capacity = computePromptCapacity({
    promptCharacterCount: input.promptCharacterCount,
    modelContextLength,
  });

  return {
    maxOutputTokens: Number(afford.maxOutputTokens),
    estimatedInputTokens: Number(request.inputTokens),
    estimatedMinimumCost: Number(afford.minCostNano) / DOLLARS_PER_NANO,
    currentUsage: capacity.currentUsage,
    capacityPercent: capacity.capacityPercent,
  };
}

/**
 * Hook to calculate budget math in real-time with debouncing.
 *
 * Pure math only — no billing decisions or notifications. Billing decisions are
 * handled by `useResolveBilling()`; notifications by `generateNotifications()`.
 *
 * Computes the initial result synchronously to avoid a flash of empty state on
 * mount; subsequent updates are debounced to avoid excessive recalculation
 * during typing.
 */
export function useBudgetCalculation(
  input: UseBudgetCalculationInput
): BudgetCalculationResult & { isBalanceLoading: boolean } {
  const { isBalanceStable } = useStability();
  const isBalanceLoading = input.isAuthenticated && !isBalanceStable;

  const tierInfo = useUserTierInfo(input.isAuthenticated);
  const { data: balanceData } = useBalance();

  // The purchased wallet is negative-capable; the free allowance is its own
  // never-negative remaining figure. Both cross the wire as NanoUSD strings, so
  // the effective balance stays exact bigint — never a cents round-trip.
  const purchasedNanoUsd = balanceData ? BigInt(balanceData.purchased.balanceNanoUsd) : 0n;
  const freeAllowanceNanoUsd = balanceData ? BigInt(balanceData.allowance.remainingNanoUsd) : 0n;

  const computeResult = React.useCallback(
    () =>
      computeBudget(input, {
        tier: tierInfo.tier,
        purchasedNanoUsd,
        freeAllowanceNanoUsd,
      }),
    [input, tierInfo.tier, purchasedNanoUsd, freeAllowanceNanoUsd]
  );

  const [debouncedResult, setDebouncedResult] =
    React.useState<BudgetCalculationResult>(computeResult);

  // Synchronously flush when the tier's *values* change (e.g. balance loaded).
  // Compared by value, not by reference: the balance query can hand back a fresh
  // object with identical values on every render (access-revoked flows
  // repeatedly invalidate it), and a reference compare would setState every
  // render → "Maximum update depth exceeded".
  const tierKey = `${tierInfo.tier}:${purchasedNanoUsd.toString()}:${freeAllowanceNanoUsd.toString()}`;
  const [previousTierKey, setPreviousTierKey] = React.useState(tierKey);
  if (previousTierKey !== tierKey) {
    setPreviousTierKey(tierKey);
    setDebouncedResult(computeResult());
  }

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedResult(computeResult());
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [computeResult]);

  return { ...debouncedResult, isBalanceLoading };
}
