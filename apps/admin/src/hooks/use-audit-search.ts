import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { auditSearchWireSchema, type AuditSearchWire } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

/** The audit-search filter dimensions; `from`/`to` are full ISO datetimes. */
export interface AuditFilters {
  readonly actor?: string | undefined;
  readonly action?: string | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export const auditKeys = {
  all: ['admin', 'audit'] as const,
  search: (filters: AuditFilters) =>
    [
      'admin',
      'audit',
      filters.actor ?? '',
      filters.action ?? '',
      filters.targetType ?? '',
      filters.targetId ?? '',
      filters.from ?? '',
      filters.to ?? '',
    ] as const,
};

// Each page is re-validated with the shared wire schema (the web app's
// response re-validation mechanic) so a drifting API shape fails the query
// loudly instead of rendering a garbage trail.
async function fetchAuditPage(
  filters: AuditFilters,
  cursor: string | undefined
): Promise<AuditSearchWire> {
  const raw = await fetchJson<unknown>(
    client.admin.audit.$get({
      query: {
        ...(filters.actor === undefined ? {} : { actor: filters.actor }),
        ...(filters.action === undefined ? {} : { action: filters.action }),
        ...(filters.targetType === undefined ? {} : { targetType: filters.targetType }),
        ...(filters.targetId === undefined ? {} : { targetId: filters.targetId }),
        ...(filters.from === undefined ? {} : { from: filters.from }),
        ...(filters.to === undefined ? {} : { to: filters.to }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    })
  );
  return auditSearchWireSchema.parse(raw);
}

export function useAuditSearch(
  filters: AuditFilters
): UseInfiniteQueryResult<InfiniteData<AuditSearchWire>> {
  return useInfiniteQuery({
    queryKey: auditKeys.search(filters),
    queryFn: ({ pageParam }) => fetchAuditPage(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
