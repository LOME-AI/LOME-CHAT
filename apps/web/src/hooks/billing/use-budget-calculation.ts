import * as React from 'react';
import {
  affordability,
  computePromptCapacity,
  estimateTokensForTier,
  evaluateManifest,
  getEffectiveBalanceNano,
  outputCharsPerTokenForTier,
  priceRequest,
  type BillableRequest,
  type Manifest,
  type UserTier,
} from '@hushbox/shared';

import { useStability } from '@/providers/stability-provider';
import { useUserTierInfo } from '@/hooks/billing/use-user-tier-info.js';
import { useSpendable } from '@/hooks/billing/use-spendable.js';

const DEBOUNCE_MS = 150;

export interface BudgetModelPricing {
  /** Billable nano-USD input rate per token (fees baked at catalog ingestion). */
  inputPerTokenNano: bigint;
  /** Billable nano-USD output rate per token (fees baked at catalog ingestion). */
  outputPerTokenNano: bigint;
  /** Model's maximum context length in tokens. */
  contextLength: number;
}

export interface UseBudgetCalculationInput {
  /** Character count for: system prompt + history + current message */
  promptCharacterCount: number;
  /** Models to include in budget calculation (billable nano rates). */
  models: BudgetModelPricing[];
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Whether the web-search tool is enabled (adds the core's worst-case reservation). */
  webSearch?: boolean;
  /**
   * Reasoning token budget B from the shared reasoning plan (0/absent =
   * reasoning-free). Priced as a constant extra output-token term on the
   * minimum estimate, mirroring the server's admission gate counting B on
   * top of the minimum answer.
   */
  reasoningBudgetTokens?: number;
}

export interface BudgetCalculationResult {
  /** Maximum output tokens the effective balance can fund (0 when insufficient). */
  maxOutputTokens: number;
  /** Estimated input tokens based on tier. */
  estimatedInputTokens: number;
  /** Estimated minimum total cost (input + minimum output), exact nano-USD. */
  estimatedMinimumCostNanoUsd: bigint;
  /** Current context usage in tokens (input + minimum output reserve). */
  currentUsage: number;
  /** Capacity percentage (currentUsage / modelContextLength * 100). */
  capacityPercent: number;
}

const ZERO_RESULT: BudgetCalculationResult = {
  maxOutputTokens: 0,
  estimatedInputTokens: 0,
  estimatedMinimumCostNanoUsd: 0n,
  currentUsage: 0,
  capacityPercent: 0,
};

interface TierFunds {
  tier: UserTier;
  /** Served spendable (`GET /billing/spendable`) — cushion- and hold-aware. */
  spendableNanoUsd: bigint;
  /** Served daily free-allowance remaining. */
  freeAllowanceNanoUsd: bigint;
}

/**
 * The effective balance the affordability solve gates against. Authenticated
 * tiers use SERVED numbers only: paid gates on the served spendable (the
 * cushion is baked in exactly once server-side — re-adding it here is the
 * double-cushion bug), free on the served daily-allowance remaining.
 * Trial/guest have no endpoint, so the shared fixed-1¢ arm stays client-side.
 */
function effectiveBalanceFor(funds: TierFunds): bigint {
  if (funds.tier === 'trial' || funds.tier === 'guest') {
    return getEffectiveBalanceNano(funds.tier, 0n, 0n);
  }
  if (funds.tier === 'free') {
    return funds.freeAllowanceNanoUsd;
  }
  return funds.spendableNanoUsd;
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
 * The effective per-output-token rate `affordability` prices with — the
 * billable model output rate plus the raw (pass-through storage) output
 * rate — re-derived from the manifest through the shared fold
 * (`evaluateManifest` at 1 vs 0 output tokens isolates the variable
 * subtotal; rates are billable at ingestion, so no fee math applies). Kept a
 * derivation, never a re-typed formula, so a manifest shape change cannot
 * silently drift this rate from the affordability solve.
 */
function effectivePerOutputTokenRateNano(manifest: Manifest): bigint {
  return (
    evaluateManifest(manifest, 1n, { scope: 'all-in' }) -
    evaluateManifest(manifest, 0n, { scope: 'all-in' })
  );
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
  funds: TierFunds
): BudgetCalculationResult {
  if (input.models.length === 0) return ZERO_RESULT;

  const request = buildRequest(input, funds.tier);
  const manifest = priceRequest(request);
  /* v8 ignore next 2 -- unreachable: models always carry bigint rates and the token/char inputs are valid, so the text-path priceRequest never fails */
  if (!manifest.ok) return ZERO_RESULT;

  const afford = affordability(manifest.value, effectiveBalanceFor(funds));

  // The reasoning budget B is a CONSTANT extra output-token term on the
  // minimum estimate (the server's admission gate counts B on top of the
  // minimum answer — reasoning tokens are billed output too).
  const reasoningSurchargeNano =
    BigInt(input.reasoningBudgetTokens ?? 0) * effectivePerOutputTokenRateNano(manifest.value);

  const modelContextLength = Math.min(...input.models.map((m) => m.contextLength));
  const capacity = computePromptCapacity({
    promptCharacterCount: input.promptCharacterCount,
    modelContextLength,
  });

  return {
    maxOutputTokens: Number(afford.maxOutputTokens),
    estimatedInputTokens: Number(request.inputTokens),
    estimatedMinimumCostNanoUsd: afford.minCostNano + reasoningSurchargeNano,
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

  const tierInfo = useUserTierInfo(input.isAuthenticated);
  // The served affordability balance — cushion- and hold-aware, exactly what
  // admission gates on (BILLING §Affordability 1). The client never re-derives
  // it from the raw balance. Pending served numbers count as loading so the
  // composer blocks instead of flashing a spurious denial.
  const { data: spendableData, isPending: isSpendablePending } = useSpendable();
  const isBalanceLoading = input.isAuthenticated && (!isBalanceStable || isSpendablePending);

  const spendableNanoUsd = spendableData ? BigInt(spendableData.spendableNanoUsd) : 0n;
  const freeAllowanceNanoUsd = tierInfo.freeAllowanceNanoUsd;

  const computeResult = React.useCallback(
    () =>
      computeBudget(input, {
        tier: tierInfo.tier,
        spendableNanoUsd,
        freeAllowanceNanoUsd,
      }),
    [input, tierInfo.tier, spendableNanoUsd, freeAllowanceNanoUsd]
  );

  const [debouncedResult, setDebouncedResult] =
    React.useState<BudgetCalculationResult>(computeResult);

  // Synchronously flush when the tier's *values* change (e.g. balance loaded).
  // Compared by value, not by reference: the balance query can hand back a fresh
  // object with identical values on every render (access-revoked flows
  // repeatedly invalidate it), and a reference compare would setState every
  // render → "Maximum update depth exceeded".
  const tierKey = `${tierInfo.tier}:${spendableNanoUsd.toString()}:${freeAllowanceNanoUsd.toString()}`;
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
