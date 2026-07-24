import * as React from 'react';
import { getUserTier, type UserBalanceState, type UserTierInfo } from '@hushbox/shared';
import { getLinkGuestAuth } from '@/lib/link-guest-auth.js';
import { useBalance } from '@/hooks/billing/billing.js';

/**
 * Hook that derives the user's balance state and tier info from balance data.
 *
 * Shared by `useBudgetCalculation` and `useResolveBilling` to avoid
 * duplicating the `balanceState` useMemo + `getUserTier()` computation.
 */
export function useUserTierInfo(isAuthenticated: boolean): UserTierInfo {
  const { data: balanceData } = useBalance();

  const balanceState = React.useMemo((): UserBalanceState | null => {
    if (!isAuthenticated) {
      return null;
    }
    if (!balanceData) {
      return null;
    }
    // The negative-capable purchased wallet is the balance the tier and the
    // negative-balance gate key on; the free-tier allowance is its own
    // (never-negative) remaining figure. Both cross the wire as NanoUSD
    // strings and stay exact bigint — cents exist only at display formatting.
    return {
      purchasedBalanceNanoUsd: BigInt(balanceData.purchased.balanceNanoUsd),
      freeAllowanceNanoUsd: BigInt(balanceData.allowance.remainingNanoUsd),
    };
  }, [isAuthenticated, balanceData]);

  const isLinkGuest = getLinkGuestAuth() != null;

  return React.useMemo(
    () => getUserTier(balanceState, { isLinkGuest }),
    [balanceState, isLinkGuest]
  );
}
