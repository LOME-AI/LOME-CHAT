import * as React from 'react';
import { X } from 'lucide-react';
import { Badge, Button, IconButton, Input, Label } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useAuditSearch, type AuditFilters } from '@/hooks/use-audit-search';
import { RateLimitedNotice } from '@/components/util/rate-limited-notice';
import { retryAfterSecondsOf } from '@/lib/rate-limited';
import { AuditActionsTable } from './audit-actions-table.js';
import { AuditRowDrawer } from './audit-row-drawer.js';
import type { AdminAuditRowWire } from '@hushbox/shared';

interface AuditTrailScreenProps {
  /** The active filters — owned by the route's URL search params. */
  readonly filters: AuditFilters;
  readonly onFiltersChange: (next: AuditFilters) => void;
}

const FILTER_FIELDS = [
  { key: 'actor', label: 'Actor', placeholder: 'ops@hushbox.ai' },
  { key: 'action', label: 'Action', placeholder: 'job.discard' },
  { key: 'targetType', label: 'Target type', placeholder: 'job' },
  { key: 'targetId', label: 'Target id', placeholder: 'uuid' },
  { key: 'from', label: 'From', placeholder: '2026-07-01T00:00:00Z' },
  { key: 'to', label: 'To', placeholder: '2026-07-15T00:00:00Z' },
] as const;

type FilterKey = (typeof FILTER_FIELDS)[number]['key'];

/** Normalizes a draft datetime to the full ISO the API validates; an
 * unparseable value is dropped rather than sent to a guaranteed 400. */
function toIsoOrUndefined(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function draftToFilters(draft: Readonly<Record<FilterKey, string>>): AuditFilters {
  const next: Record<string, string> = {};
  for (const { key } of FILTER_FIELDS) {
    const value = draft[key].trim();
    if (value === '') {
      continue;
    }
    const normalized = key === 'from' || key === 'to' ? toIsoOrUndefined(value) : value;
    if (normalized !== undefined) {
      next[key] = normalized;
    }
  }
  return next;
}

function emptyDraft(filters: AuditFilters): Record<FilterKey, string> {
  return {
    actor: filters.actor ?? '',
    action: filters.action ?? '',
    targetType: filters.targetType ?? '',
    targetId: filters.targetId ?? '',
    from: filters.from ?? '',
    to: filters.to ?? '',
  };
}

function FilterForm({
  filters,
  onApply,
}: Readonly<{ filters: AuditFilters; onApply: (next: AuditFilters) => void }>): React.JSX.Element {
  const [draft, setDraft] = React.useState<Record<FilterKey, string>>(() => emptyDraft(filters));
  return (
    <form
      data-testid={TEST_IDS.adminAuditFilters}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draftToFilters(draft));
      }}
    >
      {FILTER_FIELDS.map(({ key, label, placeholder }) => (
        <div key={key} className="flex flex-col gap-1">
          <Label htmlFor={`audit-filter-${key}`} className="text-muted-foreground text-xs">
            {label}
          </Label>
          <Input
            id={`audit-filter-${key}`}
            value={draft[key]}
            placeholder={placeholder}
            className="h-8 w-44 font-mono text-xs"
            onChange={(event) => {
              setDraft((current) => ({ ...current, [key]: event.target.value }));
            }}
          />
        </div>
      ))}
      <Button data-testid={TEST_IDS.adminAuditApplyFilters} type="submit" size="sm">
        Apply
      </Button>
    </form>
  );
}

function FilterPills({
  filters,
  onFiltersChange,
}: Readonly<{
  filters: AuditFilters;
  onFiltersChange: (next: AuditFilters) => void;
}>): React.JSX.Element | null {
  const active = FILTER_FIELDS.flatMap(({ key, label }) => {
    const value = filters[key];
    return value === undefined ? [] : [{ key, label, value }];
  });
  if (active.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {active.map(({ key, label, value }) => (
        <Badge
          key={key}
          data-testid={TEST_IDS.adminAuditFilterPill}
          variant="secondary"
          className="gap-1 font-mono text-xs"
        >
          {label.toLowerCase()}: {value}
          <IconButton
            aria-label={`Remove ${key} filter`}
            onClick={() => {
              const rest = Object.fromEntries(
                Object.entries(filters).filter(([filterKey]) => filterKey !== key)
              );
              onFiltersChange(rest);
            }}
          >
            <X className="h-3 w-3" />
          </IconButton>
        </Badge>
      ))}
    </div>
  );
}

function TrailBody({
  query,
  rows,
  inspectedId,
  onInspect,
}: Readonly<{
  query: ReturnType<typeof useAuditSearch>;
  rows: readonly AdminAuditRowWire[];
  inspectedId: string | undefined;
  onInspect: (row: AdminAuditRowWire) => void;
}>): React.JSX.Element {
  if (query.isPending) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (query.isError) {
    const retryAfter = retryAfterSecondsOf(query.error);
    if (retryAfter !== null) {
      return (
        <RateLimitedNotice
          retryAfterSeconds={retryAfter}
          resetKey={query.errorUpdatedAt}
          onRetry={() => {
            void query.refetch();
          }}
        />
      );
    }
    return <p className="text-destructive text-sm">Failed to load the audit trail.</p>;
  }
  if (rows.length === 0) {
    return (
      <p data-testid={TEST_IDS.adminAuditEmpty} className="text-muted-foreground text-sm">
        No audit rows match these filters. Every admin mutation and sensitive read writes an audit
        row, so an empty result means the filters are too narrow, not that activity went unrecorded.
      </p>
    );
  }
  return (
    <>
      <AuditActionsTable rows={rows} onInspect={onInspect} inspectedId={inspectedId} />
      {query.hasNextPage ? (
        <div>
          <Button
            data-testid={TEST_IDS.adminAuditLoadMore}
            variant="outline"
            size="sm"
            disabled={query.isFetchingNextPage}
            onClick={() => {
              void query.fetchNextPage();
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Arrow-key stepping, clamped at both ends of the loaded rows. */
export function stepAuditSelection(
  rows: readonly AdminAuditRowWire[],
  currentId: string | null,
  direction: 1 | -1
): string | null {
  const index = rows.findIndex((row) => row.id === currentId);
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + direction))];
  return next?.id ?? currentId;
}

/**
 * The audit trail: URL-owned filter pills over the shared actions table,
 * newest-first with cursor pagination, and a side drawer for row inspection.
 */
export function AuditTrailScreen({
  filters,
  onFiltersChange,
}: AuditTrailScreenProps): React.JSX.Element {
  const [inspectedId, setInspectedId] = React.useState<string | null>(null);
  const query = useAuditSearch(filters);
  const rows = React.useMemo(
    () => query.data?.pages.flatMap((page) => page.rows) ?? [],
    [query.data]
  );
  const inspected = rows.find((row) => row.id === inspectedId);

  const step = React.useCallback(
    (direction: 1 | -1) => {
      setInspectedId((current) => stepAuditSelection(rows, current, direction));
    },
    [rows]
  );

  const jump = React.useCallback(
    (auditId: string) => {
      if (rows.some((row) => row.id === auditId)) {
        setInspectedId(auditId);
      }
    },
    [rows]
  );

  const close = React.useCallback(() => {
    setInspectedId(null);
  }, []);

  return (
    <section className="flex flex-col gap-4 p-4">
      <h1 className="text-[1.2rem] font-bold">Audit trail</h1>
      <FilterForm
        // Remounts the drafts when the URL-owned filters change (pill removal,
        // back/forward), so the form never shows stale values.
        key={JSON.stringify(filters)}
        filters={filters}
        onApply={onFiltersChange}
      />
      <FilterPills filters={filters} onFiltersChange={onFiltersChange} />
      <TrailBody
        query={query}
        rows={rows}
        inspectedId={inspected?.id}
        onInspect={(row) => {
          setInspectedId(row.id);
        }}
      />
      {inspected === undefined ? null : (
        <AuditRowDrawer row={inspected} onClose={close} onStep={step} onJump={jump} />
      )}
    </section>
  );
}
