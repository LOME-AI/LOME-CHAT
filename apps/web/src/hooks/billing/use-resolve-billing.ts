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
  /**
   * The conversation being composed in, which NAMES the payer. It is required
   * rather than optional because omitting it does not ask a simpler question —
   * it asks the WRONG one, against a second cache entry for the same payer's
   * figure while every sibling hook reads the scoped one. `null` for a solo
   * composer, whose payer is the caller.
   */
  conversationId: string | null;
}

/**
 * Hook that resolves billing for the current message.
 *
 * Delegates the who-pays + premium decision to the shared
 * `resolveClientBilling()`, which routes through the same `resolveFunding`
 * core the server uses. No group dimension is passed, so the core resolves the
 * solo arm here and the payer of a group turn is the SERVED one; the send path
 * is where priority 1's comparison is made, against the minimum it prices. It
 * layers the client-only affordability / trial vocabulary on top. The affordability input
 * for every tier with a funding door is the SERVED spendable (`useSpendable`) —
 * cushion- and hold-aware, never re-derived from the raw balance and never
 * composed with a second figure; the raw balance feeds only the
 * negative-balance hard block and tier derivation.
 *
 * Returns a `ResolveBillingResult` — either a `fundingSource` or `{ fundingSource: 'denied', reason }`.
 */
export function useResolveBilling(input: UseResolveBillingInput): ResolveBillingResult {
  const tierInfo = useUserTierInfo(input.isAuthenticated);
  const { data: spendableData } = useSpendable(input.conversationId);
  const spendableNanoUsd = spendableData ? BigInt(spendableData.spendableNanoUsd) : 0n;

  return React.useMemo(
    () =>
      resolveClientBilling({
        tier: tierInfo.tier,
        purchasedBalanceNanoUsd: tierInfo.purchasedBalanceNanoUsd,
        spendableNanoUsd,
        isPremiumModel: input.isPremiumModel,
        estimatedMinimumCostNanoUsd: input.estimatedMinimumCostNanoUsd,
      }),
    [
      tierInfo.tier,
      tierInfo.purchasedBalanceNanoUsd,
      spendableNanoUsd,
      input.isPremiumModel,
      input.estimatedMinimumCostNanoUsd,
    ]
  );
}
