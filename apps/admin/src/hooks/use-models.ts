import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { adminModelsWireSchema, type AdminModelsWire } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

export const modelsKeys = {
  all: ['admin', 'models'] as const,
};

// The catalog payload is re-validated with the shared wire schema (the web
// app's response re-validation mechanic) so a drifting API shape fails the
// query loudly instead of rendering a garbage catalog.
async function fetchModels(): Promise<AdminModelsWire> {
  const raw = await fetchJson<unknown>(client.admin.models.$get());
  return adminModelsWireSchema.parse(raw);
}

export function useModels(): UseQueryResult<AdminModelsWire> {
  return useQuery({
    queryKey: modelsKeys.all,
    queryFn: fetchModels,
  });
}
