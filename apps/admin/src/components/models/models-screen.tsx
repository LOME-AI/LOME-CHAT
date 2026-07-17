import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Input } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { modelsKeys, useModels } from '@/hooks/use-models';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { CopyableId } from '@/components/util/copyable-id';
import { RateLimitedNotice } from '@/components/util/rate-limited-notice';
import { retryAfterSecondsOf } from '@/lib/rate-limited';
import type { AdminModelWire } from '@hushbox/shared';

function ZdrChip({
  zdrReachable,
}: Readonly<Pick<AdminModelWire, 'zdrReachable'>>): React.JSX.Element {
  if (zdrReachable === null) {
    return <Badge variant="outline">ZDR unknown</Badge>;
  }
  return zdrReachable ? (
    <Badge variant="secondary">ZDR</Badge>
  ) : (
    <Badge variant="outline">Not ZDR</Badge>
  );
}

function StatusChip({
  adminDisabledAt,
}: Readonly<Pick<AdminModelWire, 'adminDisabledAt'>>): React.JSX.Element {
  if (adminDisabledAt === null) {
    return <Badge variant="secondary">Enabled</Badge>;
  }
  return <Badge variant="destructive">Disabled {adminDisabledAt.slice(0, 10)}</Badge>;
}

/** The kill switch: one op per direction, prefilled with the row's model id. */
function ModelActions({ model }: Readonly<{ model: AdminModelWire }>): React.JSX.Element {
  const runOp = useRunOp();
  if (model.adminDisabledAt !== null) {
    return (
      <Button
        data-testid={TEST_IDS.adminModelEnable}
        size="sm"
        variant="outline"
        onClick={() => {
          runOp({ opName: 'model.enable', initialValues: { modelId: model.modelId } });
        }}
      >
        Enable
      </Button>
    );
  }
  return (
    <Button
      data-testid={TEST_IDS.adminModelDisable}
      size="sm"
      variant="outline"
      onClick={() => {
        runOp({ opName: 'model.disable', initialValues: { modelId: model.modelId } });
      }}
    >
      Disable
    </Button>
  );
}

function ModelsTable({ rows }: Readonly<{ rows: readonly AdminModelWire[] }>): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table data-testid={TEST_IDS.adminModelsTable} className="w-full text-left text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-xs uppercase">
            <th className="py-1 pr-2 font-medium">Model</th>
            <th className="py-1 pr-2 font-medium">Name</th>
            <th className="py-1 pr-2 font-medium">Family</th>
            <th className="py-1 pr-2 font-medium">ZDR</th>
            <th className="py-1 pr-2 font-medium">Status</th>
            <th className="py-1 pr-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((model) => (
            <tr key={model.modelId} className="border-border border-b align-top">
              <td className="py-1 pr-2">
                <CopyableId value={model.modelId} label="model id" />
              </td>
              <td className="py-1 pr-2 text-xs">{model.name ?? ''}</td>
              <td className="py-1 pr-2 font-mono text-xs">{model.family ?? ''}</td>
              <td className="py-1 pr-2">
                <ZdrChip zdrReachable={model.zdrReachable} />
              </td>
              <td className="py-1 pr-2">
                <StatusChip adminDisabledAt={model.adminDisabledAt} />
              </td>
              <td className="py-1 pr-2">
                <ModelActions model={model} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Client-side substring filter over model id + name (the whole catalog is
 * already loaded; ~350 rows need narrowing, not paging). */
export function filterModels(
  models: readonly AdminModelWire[],
  filter: string
): readonly AdminModelWire[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') {
    return models;
  }
  return models.filter(
    (model) =>
      model.modelId.toLowerCase().includes(needle) ||
      (model.name ?? '').toLowerCase().includes(needle)
  );
}

function ScreenBody({
  query,
  filter,
}: Readonly<{ query: ReturnType<typeof useModels>; filter: string }>): React.JSX.Element {
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
    return <p className="text-destructive text-sm">Failed to load the model catalog.</p>;
  }
  if (query.data.models.length === 0) {
    return (
      <p data-testid={TEST_IDS.adminModelsEmpty} className="text-muted-foreground text-sm">
        No models in the catalog. The catalog is auto-discovered from OpenRouter&apos;s live
        metadata by the hourly refresh: models appear here on their own, including kill-switched and
        exposure-hidden ones; an empty catalog means the refresh has not run yet.
      </p>
    );
  }
  const rows = filterModels(query.data.models, filter);
  return (
    <>
      {query.data.truncated ? (
        <Badge
          data-testid={TEST_IDS.adminModelsTruncated}
          variant="outline"
          className="text-destructive self-start"
        >
          Truncated at the server cap; this is not the whole catalog
        </Badge>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No models match <span className="font-mono">{filter.trim()}</span>.
        </p>
      ) : (
        <ModelsTable rows={rows} />
      )}
    </>
  );
}

/**
 * The model catalog screen: every persisted model including kill-switched and
 * exposure-hidden rows (the admin read sees through the product gate), with
 * the per-row Disable/Enable kill switch flowing through the OpModal.
 */
export function ModelsScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useModels();
  const [filter, setFilter] = React.useState('');
  return (
    <section className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[1.2rem] font-bold">Models</h1>
        <Button
          data-testid={TEST_IDS.adminModelsRefresh}
          size="sm"
          variant="outline"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: modelsKeys.all });
          }}
        >
          Refresh
        </Button>
      </div>
      <Input
        data-testid={TEST_IDS.adminModelsFilter}
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
        placeholder="Filter by model id or name"
        aria-label="Filter models by id or name"
        className="h-8 max-w-sm font-mono text-xs"
      />
      <ScreenBody query={query} filter={filter} />
    </section>
  );
}
