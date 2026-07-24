import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useSession } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client.js';
import { billingKeys } from '@/hooks/billing/billing.js';
import type { GetSpendableResponse } from '@hushbox/shared';

/**
 * The served affordability balance (`GET /billing/spendable`): cushion- and
 * hold-aware, exactly what admission's balance gate compares (BILLING
 * §Affordability 1). This is THE affordability balance input for authenticated
 * users — the client never re-derives spendable from the raw balance (the
 * served number bakes the cushion exactly once; re-adding it client-side is
 * the double-cushion bug). `useBalance` remains for payment-confirmation
 * polling and display only. Trial/guest users have no endpoint (fixed-1¢ arm
 * stays client-side), so the query is disabled for them.
 *
 * Freshness rides the WS frames (`run-started`, `run-finished`, ws-ready
 * catch-up) invalidating `billingKeys.spendable()` — zero per-keystroke calls.
 */
export function useSpendable(): UseQueryResult<GetSpendableResponse> {
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);

  return useQuery({
    queryKey: billingKeys.spendable(),
    queryFn: () => fetchJson(client.billing.spendable.$get()),
    enabled: isAuthenticated,
  });
}
