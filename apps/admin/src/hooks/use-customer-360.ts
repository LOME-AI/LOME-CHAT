import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { customer360ViewSchema, type Customer360View } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

export const customer360Keys = {
  all: ['admin', 'customer-360'] as const,
  byQuery: (q: string) => ['admin', 'customer-360', q] as const,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One search box, two lookup keys: a uuid is a userId, anything else an
 * email (the overview route accepts exactly one of the two). */
export function customer360QueryFor(
  q: string
): { readonly email: string } | { readonly userId: string } {
  const trimmed = q.trim();
  return UUID_PATTERN.test(trimmed) ? { userId: trimmed } : { email: trimmed };
}

// The view payload is re-validated with the shared wire schema (the web
// app's response re-validation mechanic) so a drifting API shape fails the
// query loudly instead of rendering garbage panels.
async function fetchCustomer360(q: string): Promise<Customer360View> {
  const raw = await fetchJson<unknown>(
    client.admin.users.overview.$get({ query: customer360QueryFor(q) })
  );
  return customer360ViewSchema.parse(raw);
}

export function useCustomer360(q: string | undefined): UseQueryResult<Customer360View> {
  const trimmed = (q ?? '').trim();
  return useQuery({
    queryKey: customer360Keys.byQuery(trimmed),
    queryFn: () => fetchCustomer360(trimmed),
    enabled: trimmed !== '',
  });
}
