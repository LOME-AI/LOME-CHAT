import * as React from 'react';
import { resolveBilling, type UserTier, type ResolveBillingResult } from '@hushbox/shared';
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
    ownerTier: UserTier;
    ownerBalanceCents: number;
  };
}

/**
 * Hook that resolves billing for the current message.
 * Calls `resolveBilling()` from `@hushbox/shared` with user's balance data.
 *
 * Returns a `ResolveBillingResult` — either a `fundingSource` or `{ fundingSource: 'denied', reason }`.
 */
export function useResolveBilling(input: UseResolveBillingInput): ResolveBillingResult {
  const tierInfo = useUserTierInfo(input.isAuthenticated);

  return React.useMemo(() => {
    // A negative balance on the wallet that would fund this turn hard-blocks new
    // paid turns until top-up (§13 — a negative balance lives on the purchased
    // wallet and never offsets against the free allowance). The server's
    // admission is authoritative; surfacing the denial here disables the composer
    // before the request is sent. The relevant wallet is the owner's for a group
    // turn, the caller's own otherwise. Only an overdrawn purchased wallet can go
    // below zero, so a negative figure uniquely identifies the block.
    const payerBalanceCents =
      input.group === undefined ? tierInfo.balanceCents : input.group.ownerBalanceCents;
    if (payerBalanceCents < 0) {
      return { fundingSource: 'denied', reason: 'insufficient_balance' };
    }

    return resolveBilling({
      tier: tierInfo.tier,
      balanceCents: tierInfo.balanceCents,
      freeAllowanceCents: tierInfo.freeAllowanceCents,
      isPremiumModel: input.isPremiumModel,
      estimatedMinimumCostCents: input.estimatedMinimumCostCents,
      ...(input.group !== undefined && { group: input.group }),
    });
  }, [
    tierInfo.tier,
    tierInfo.balanceCents,
    tierInfo.freeAllowanceCents,
    input.isPremiumModel,
    input.estimatedMinimumCostCents,
    input.group,
  ]);
}
