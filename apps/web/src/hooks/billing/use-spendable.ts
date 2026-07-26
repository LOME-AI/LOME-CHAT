import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useSession } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client.js';
import { billingKeys } from '@/hooks/billing/billing.js';
import type { GetSpendableResponse } from '@hushbox/shared';

/**
 * The PAYER's funding snapshot (`GET /billing/spendable`): hold-aware
 * spendable, what holds took off it, and the tier and identity of the wallet
 * those figures describe (BILLING §Affordability 1, §Group Funding 1). This is
 * THE affordability input for authenticated users — the client never re-derives
 * spendable from the raw balance (the served number bakes the cushion exactly
 * once; re-adding it client-side is the double-cushion bug), and never
 * re-derives the payer's tier either. `useBalance` remains for
 * payment-confirmation polling and display only. Trial/guest users have no
 * endpoint (the fixed-1¢ arm stays client-side), so the query is disabled for
 * them.
 *
 * `conversationId` is what makes the answer the payer's: in a group conversation
 * the owner's funds and tier price the turn, so a conversation-blind read serves
 * a member the wrong wallet AND the wrong tier. Each payer caches under its own
 * key, all under one family prefix.
 *
 * Freshness rides the WS frames (`run-started`, `run-finished`, ws-ready
 * catch-up) invalidating the `billingKeys.spendable()` prefix — zero
 * per-keystroke calls.
 */
export function useSpendable(conversationId?: string | null): UseQueryResult<GetSpendableResponse> {
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);
  const scope = conversationId ?? null;

  return useQuery({
    queryKey: billingKeys.spendableFor(scope),
    queryFn: () =>
      fetchJson(
        client.billing.spendable.$get({
          query: scope === null ? {} : { conversationId: scope },
        })
      ),
    enabled: isAuthenticated,
  });
}
