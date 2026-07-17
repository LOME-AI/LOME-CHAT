import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { sqlPanelResultWireSchema, type SqlPanelResultWire } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

// A mutation, not a query: the panel runs imperatively (Run / Cmd+Enter) and
// results must never be cache-shared or refetched behind the operator's back.
// The read itself is server-side SELECT-only; the result page is re-validated
// with the shared wire schema.
async function runSqlQuery(queryText: string): Promise<SqlPanelResultWire> {
  const raw = await fetchJson<unknown>(client.admin.sql.$get({ query: { query: queryText } }));
  return sqlPanelResultWireSchema.parse(raw);
}

export function useSqlPanel(): UseMutationResult<SqlPanelResultWire, unknown, string> {
  return useMutation({ mutationFn: runSqlQuery });
}
