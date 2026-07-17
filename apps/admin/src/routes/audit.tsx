import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AuditTrailScreen } from '@/components/audit/audit-trail-screen';
import type { AuditFilters } from '@/hooks/use-audit-search';

const FILTER_KEYS = ['actor', 'action', 'targetType', 'targetId', 'from', 'to'] as const;

function Screen(): React.JSX.Element {
  const filters = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AuditTrailScreen
      filters={filters}
      onFiltersChange={(next) => {
        void navigate({ search: next });
      }}
    />
  );
}

export const Route = createFileRoute('/audit')({
  // The filters live in the URL so a filtered trail view is shareable and
  // survives reload; empty strings are dropped rather than sent as filters.
  // Datetimes are normalized-or-dropped here too: the form path already
  // normalizes, but a hand-edited URL would otherwise reach the API as a
  // guaranteed 400.
  validateSearch: (search: Record<string, unknown>): AuditFilters =>
    Object.fromEntries(
      FILTER_KEYS.flatMap((key): [string, string][] => {
        const value = search[key];
        if (typeof value !== 'string' || value === '') {
          return [];
        }
        if (key === 'from' || key === 'to') {
          const parsed = new Date(value);
          return Number.isNaN(parsed.getTime()) ? [] : [[key, parsed.toISOString()]];
        }
        return [[key, value]];
      })
    ),
  component: Screen,
});
