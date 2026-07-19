import * as React from 'react';
import { resolveClientBilling, type ResolveBillingResult } from '@hushbox/shared';
import { useUserTierInfo } from '@/hooks/billing/use-user-tier-info.js';

export interface UseResolveBillingInput {
  /** Estimated minimum cost in cents (from calculateBudget().estimatedMinimumCost * 100) */
  estimatedMinimumCostCents: number;
  /** Whether the selected model is premium */
  isPremiumModel: boolean;
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Group budget context from useConversationBudgets */
  group?: {
    effectiveCents: number;
    ownerBalanceCents: number;
  };
}

/**
 * Hook that resolves billing for the current message.
 *
 * Delegates the who-pays + premium decision to the shared
 * `resolveClientBilling()`, which routes through the same `resolveFundingDecision`
 * core the server uses (so the two sides cannot drift) and layers the
 * client-only affordability / trial vocabulary on top.
 *
 * Returns a `ResolveBillingResult` — either a `fundingSource` or `{ fundingSource: 'denied', reason }`.
 */
export function useResolveBilling(input: UseResolveBillingInput): ResolveBillingResult {
  const tierInfo = useUserTierInfo(input.isAuthenticated);

  return React.useMemo(
    () =>
      resolveClientBilling({
        tier: tierInfo.tier,
        balanceCents: tierInfo.balanceCents,
        freeAllowanceCents: tierInfo.freeAllowanceCents,
        isPremiumModel: input.isPremiumModel,
        estimatedMinimumCostCents: input.estimatedMinimumCostCents,
        ...(input.group !== undefined && { group: input.group }),
      }),
    [
      tierInfo.tier,
      tierInfo.balanceCents,
      tierInfo.freeAllowanceCents,
      input.isPremiumModel,
      input.estimatedMinimumCostCents,
      input.group,
    ]
  );
}
