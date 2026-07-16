import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { adminOpsCatalogSchema, type AdminOpsCatalog } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

export const opsKeys = {
  all: ['admin', 'ops'] as const,
};

// The catalog payload is re-validated with the shared wire schema (the web
// app's response re-validation mechanic) so a drifting API shape fails the
// query loudly instead of rendering garbage forms.
async function fetchOps(): Promise<AdminOpsCatalog> {
  const raw = await fetchJson<unknown>(client.admin.ops.$get());
  return adminOpsCatalogSchema.parse(raw);
}

export function useOps(options?: { readonly enabled?: boolean }): UseQueryResult<AdminOpsCatalog> {
  return useQuery({
    queryKey: opsKeys.all,
    queryFn: fetchOps,
    enabled: options?.enabled ?? true,
  });
}
