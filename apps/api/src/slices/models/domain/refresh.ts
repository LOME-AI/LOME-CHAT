import { canonicalJson } from '../../../lib/idempotency/index.js';
import { ResultAsync, err, ok, okAsync } from '../../../lib/result/index.js';
import { readLatestDescriptorRows, upsertCatalog } from './catalog-store.js';
import { fetchGatewayCatalog } from './gateway-metadata.js';
import { normalizeModel } from './normalize.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { StoredDescriptorRow } from './catalog-store.js';
import type { GatewayCatalog } from './gateway-metadata.js';
import type { ExcludeReason } from './normalize.js';
import type { Result } from '../../../lib/result/index.js';

/**
 * The catalog refresh: fetch OpenRouter metadata (models + ZDR + image +
 * video), normalize, upsert one row per model skip-unchanged. Designed for an
 * hourly cron trigger (the caller passes `jitter` so a fleet of triggers
 * spreads out); an internal consumer, so no Idempotency-Key header — every
 * write goes through `idempotent.byUpsert` on UNIQUE(model_id), which also
 * makes concurrent refreshes converge.
 */

export interface RefreshJitter {
  readonly maxMs: number;
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface RefreshCatalogDeps {
  readonly db: Database;
  readonly fetch: typeof globalThis.fetch;
  readonly gatewayBaseUrl: string;
  readonly telemetry: Telemetry;
  readonly now: () => Date;
  readonly jitter?: RefreshJitter;
}

export interface RefreshSummary {
  readonly discovered: number;
  readonly written: number;
  readonly unchanged: number;
  readonly excluded: number;
}

function jitterDelay(jitter: RefreshJitter | undefined): ResultAsync<void, DomainError> {
  if (jitter === undefined) return okAsync();
  const delayMs = Math.floor(jitter.random() * jitter.maxMs);
  return ResultAsync.fromSafePromise(jitter.sleep(delayMs));
}

/** Content equality for skip-unchanged: the stored wire descriptor minus
 * the per-write stamps (`version`, `fetchedAt`). */
function storedContentMatches(
  stored: StoredDescriptorRow | undefined,
  contentJson: string
): boolean {
  if (stored === undefined) return false;
  if (typeof stored.descriptor !== 'object' || stored.descriptor === null) return false;
  const storedContent = Object.fromEntries(
    Object.entries(stored.descriptor).filter(([key]) => key !== 'version' && key !== 'fetchedAt')
  );
  return canonicalJson(storedContent) === contentJson;
}

/** A fail-closed exclusion (unclassifiable modality, unknown pricing unit)
 * rides the error-capture channel (Sentry-visible). Deprecation is expected
 * lifecycle and never pages — it is only counted. The log messages are
 * compile-time literals (SafeLogFields rule): the model id is a field. */
function alertExcluded(telemetry: Telemetry, modelId: string, reason: ExcludeReason): void {
  if (reason === 'unknown-pricing-unit') {
    telemetry.error('video model has an unknown pricing unit — model excluded', {
      modelName: modelId,
      errorCode: 'model_pricing_unit_unknown',
    });
    telemetry.captureError(
      new Error('video model has an unknown pricing unit — model excluded'),
      'model_pricing_unit_unknown'
    );
    return;
  }
  if (reason === 'unclassifiable-modality') {
    telemetry.error('gateway model modality has no call-shape family — model excluded', {
      modelName: modelId,
      errorCode: 'model_type_unknown',
    });
    telemetry.captureError(
      new Error('gateway model modality has no call-shape family — model excluded'),
      'model_type_unknown'
    );
  }
}

type ModelDisposition = 'written' | 'unchanged' | 'excluded';

async function persistModel(
  deps: RefreshCatalogDeps,
  zdrModelIds: ReadonlySet<string>,
  model: GatewayCatalog['models'][number],
  stored: StoredDescriptorRow | undefined
): Promise<Result<ModelDisposition, DomainError>> {
  const outcome = normalizeModel(model, zdrModelIds);
  if (outcome.kind === 'excluded') {
    alertExcluded(deps.telemetry, outcome.modelId, outcome.reason);
    return ok('excluded');
  }
  if (storedContentMatches(stored, canonicalJson(outcome.content))) return ok('unchanged');
  const upsert = await upsertCatalog(deps.db, {
    modelId: model.id,
    content: outcome.content,
    fetchedAt: deps.now(),
  });
  if (upsert.isErr()) return err(upsert.error);
  return ok('written');
}

async function persistCatalog(
  deps: RefreshCatalogDeps,
  catalog: GatewayCatalog,
  latest: ReadonlyMap<string, StoredDescriptorRow>
): Promise<Result<RefreshSummary, DomainError>> {
  const counts: Record<ModelDisposition, number> = { written: 0, unchanged: 0, excluded: 0 };
  for (const model of catalog.models) {
    const disposition = await persistModel(deps, catalog.zdrModelIds, model, latest.get(model.id));
    if (disposition.isErr()) return err(disposition.error);
    counts[disposition.value] += 1;
  }
  return ok({ discovered: catalog.models.length, ...counts });
}

export function refreshCatalog(deps: RefreshCatalogDeps): ResultAsync<RefreshSummary, DomainError> {
  return jitterDelay(deps.jitter)
    .andThen(() => fetchGatewayCatalog({ baseUrl: deps.gatewayBaseUrl, fetch: deps.fetch }))
    .andThen((catalog) =>
      readLatestDescriptorRows(deps.db).andThen(
        (latest) => new ResultAsync(persistCatalog(deps, catalog, latest))
      )
    );
}
