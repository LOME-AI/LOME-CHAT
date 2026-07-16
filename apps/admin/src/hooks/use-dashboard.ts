import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { dashboardWireSchema, type DashboardWire } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

export const dashboardKeys = {
  all: ['admin', 'dashboard'] as const,
};

// The dashboard payload is re-validated with the shared wire schema (the web
// app's response re-validation mechanic) so a drifting API shape fails the
// query loudly instead of rendering garbage.
async function fetchDashboard(): Promise<DashboardWire> {
  const raw = await fetchJson<unknown>(client.admin.dashboard.$get());
  return dashboardWireSchema.parse(raw);
}

export function useDashboard(): UseQueryResult<DashboardWire> {
  return useQuery({
    queryKey: dashboardKeys.all,
    queryFn: fetchDashboard,
  });
}
