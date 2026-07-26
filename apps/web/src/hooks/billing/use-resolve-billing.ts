import * as React from 'react';
import { resolveClientBilling, type ResolveBillingResult } from '@hushbox/shared';
import { useUserTierInfo } from '@/hooks/billing/use-user-tier-info.js';
import { useSpendable } from '@/hooks/billing/use-spendable.js';

export interface UseResolveBillingInput {
  /** Estimated minimum cost in exact nano-USD (shared estimator output). */
  estimatedMinimumCostNanoUsd: bigint;
  /** Whether the selected model is premium */
  isPremiumModel: boolean;
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Group budget context from useConversationBudgets (served nano figures). */
  group?: {
    effectiveRemainingNanoUsd: bigint;
    ownerBalanceNanoUsd: bigint;
  };
}

/**
 * Hook that resolves billing for the current message.
 *
 * Delegates the who-pays + premium decision to the shared
 * `resolveClientBilling()`, which routes through the same `resolveFundingDecision`
 * core the server uses — the same rule, not necessarily the same verdict: this
 * path feeds the core the turn's estimate and the server's payer freeze feeds it
 * none, so a group member whose headroom is positive but below the estimate
 * resolves to personal funds here while the server resolves the owner and
 * admission refuses the send. It layers the
 * client-only affordability / trial vocabulary on top. The paid affordability
 * input is the SERVED spendable (`useSpendable`) — cushion- and hold-aware,
 * never re-derived from the raw balance; the raw balance feeds only the
 * negative-balance hard block and tier derivation.
 *
 * Returns a `ResolveBillingResult` — either a `fundingSource` or `{ fundingSource: 'denied', reason }`.
 */
export function useResolveBilling(input: UseResolveBillingInput): ResolveBillingResult {
  const tierInfo = useUserTierInfo(input.isAuthenticated);
  const { data: spendableData } = useSpendable();
  const spendableNanoUsd = spendableData ? BigInt(spendableData.spendableNanoUsd) : 0n;

  return React.useMemo(
    () =>
      resolveClientBilling({
        tier: tierInfo.tier,
        purchasedBalanceNanoUsd: tierInfo.purchasedBalanceNanoUsd,
        spendableNanoUsd,
        freeAllowanceNanoUsd: tierInfo.freeAllowanceNanoUsd,
        isPremiumModel: input.isPremiumModel,
        estimatedMinimumCostNanoUsd: input.estimatedMinimumCostNanoUsd,
        ...(input.group !== undefined && { group: input.group }),
      }),
    [
      tierInfo.tier,
      tierInfo.purchasedBalanceNanoUsd,
      tierInfo.freeAllowanceNanoUsd,
      spendableNanoUsd,
      input.isPremiumModel,
      input.estimatedMinimumCostNanoUsd,
      input.group,
    ]
  );
}
