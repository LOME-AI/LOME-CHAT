import * as React from 'react';
import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { AuditTrailScreen } from '@/components/audit/audit-trail-screen';
import type { AuditFilters } from '@/hooks/use-audit-search';

const nonEmpty = z.string().min(1);

// A URL-supplied datetime is normalized to full ISO or dropped: the form path
// already normalizes, but a hand-edited URL would otherwise reach the API as a
// guaranteed 400. Empty or non-string values fail the schema and are dropped.
const isoDatetime = z
  .string()
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()))
  .transform((date) => date.toISOString());

const FILTER_SCHEMAS = {
  actor: nonEmpty,
  action: nonEmpty,
  targetType: nonEmpty,
  targetId: nonEmpty,
  from: isoDatetime,
  to: isoDatetime,
} as const;

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
  // survives reload; each dimension is validated independently so one bad
  // value never drops a sibling filter.
  validateSearch: (search: Record<string, unknown>): AuditFilters =>
    Object.fromEntries(
      Object.entries(FILTER_SCHEMAS).flatMap(([key, schema]) => {
        const parsed = schema.safeParse(search[key]);
        return parsed.success ? [[key, parsed.data]] : [];
      })
    ),
  component: Screen,
});
