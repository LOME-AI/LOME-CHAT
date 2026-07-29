import * as React from 'react';
import { tierCanAccessPremium } from '@hushbox/shared';
import { useSession } from '@/lib/auth';
import { hasServedFunding, useSpendable } from '@/hooks/billing/use-spendable.js';

/**
 * Premium reach, or the fact that it is not yet known. The union is the point:
 * `canAccessPremium` is unreadable while the snapshot is outstanding, so a
 * surface cannot resolve a model at the wrong tier and then keep the answer.
 */
export type PayerPremiumAccess =
  | { isPending: true }
  | { isPending: false; canAccessPremium: boolean };

/**
 * Whether the PAYER of `conversationId` can reach premium models.
 *
 * Two facts make this one hook rather than a line in each caller. Premium is
 * decided by the served tier and never by a balance (`docs/BILLING.md`
 * §Affordability 4), and the tier that decides it belongs to whoever pays —
 * an owner-funded member or link guest reaches what the OWNER reaches
 * (§Group Funding 1). Model surfaces that derive that fact themselves drift
 * from the option sets the composer renders, which read the same snapshot
 * through the money layer's adapter hook.
 *
 * `conversationId` is required because omitting it is not a simpler question:
 * it reads the caller's own wallet in a conversation somebody else funds.
 * `null` is the honest answer only where there is no conversation, whose payer
 * is the caller.
 */
export function usePayerPremiumAccess(conversationId: string | null): PayerPremiumAccess {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: served } = useSpendable(conversationId);
  const isAuthenticated = Boolean(session?.user);

  return React.useMemo((): PayerPremiumAccess => {
    if (isSessionPending) return { isPending: true };
    // A caller with no funding door (the trial) never resolves the query, so
    // its permanent absence must not gate it; a caller that HAS one is gated
    // until the snapshot is in hand, or it answers at its own tier and keeps
    // the answer.
    if (hasServedFunding(isAuthenticated, conversationId) && served === undefined) {
      return { isPending: true };
    }
    return {
      isPending: false,
      canAccessPremium: served !== undefined && tierCanAccessPremium(served.payerTier),
    };
  }, [isSessionPending, isAuthenticated, conversationId, served]);
}
