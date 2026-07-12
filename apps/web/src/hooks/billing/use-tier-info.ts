import * as React from 'react';
import { getUserTier, nanoUsdToCents, type UserTierInfo } from '@hushbox/shared';
import { useSession } from '@/lib/auth';
import { getLinkGuestAuth } from '@/lib/link-guest-auth.js';
import { useBalance } from '@/hooks/billing/billing.js';

/**
 * Hook to get user tier info including canAccessPremium.
 * Single source of truth for frontend tier determination.
 *
 * Returns null when the tier cannot be determined yet (session or balance loading).
 * Uses getUserTier() from @hushbox/shared to ensure consistency
 * with backend tier determination.
 */
export function useTierInfo(): UserTierInfo | null {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: balanceData } = useBalance();

  return React.useMemo((): UserTierInfo | null => {
    // Session still loading — we don't know if user is authenticated
    if (isSessionPending) {
      return null;
    }

    const isAuthenticated = Boolean(session?.user);

    // Not authenticated — we know the answer
    if (!isAuthenticated) {
      return getUserTier(null, { isLinkGuest: getLinkGuestAuth() != null });
    }

    // Authenticated but balance not loaded — don't guess
    if (!balanceData) {
      return null;
    }

    return getUserTier({
      balanceCents: nanoUsdToCents(balanceData.purchased.balanceNanoUsd),
      freeAllowanceCents: nanoUsdToCents(balanceData.allowance.remainingNanoUsd),
    });
  }, [isSessionPending, session, balanceData]);
}
