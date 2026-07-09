import { canonicalJson } from '../../../lib/idempotency/index.js';
import { ResultAsync, err, ok, okAsync } from '../../../lib/result/index.js';
import { readLatestDescriptorRows, upsertCatalog } from './catalog-store.js';
import { fetchGatewayCatalog } from './gateway-metadata.js';
import { normalizeCatalog } from './normalize.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { StoredDescriptorRow } from './catalog-store.js';
import type { CatalogEntry, ExcludeReason } from './normalize.js';
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

/** A fail-closed exclusion (unclassifiable modality, unknown pricing unit,
 * missing release date) rides the error-capture channel (Sentry-visible).
 * Deprecation is expected lifecycle and never pages — it is only counted. The
 * log messages are
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
    return;
  }
  if (reason === 'missing-release-date') {
    telemetry.error('gateway model has no release date — model excluded', {
      modelName: modelId,
      errorCode: 'model_release_date_missing',
    });
    telemetry.captureError(
      new Error('gateway model has no release date — model excluded'),
      'model_release_date_missing'
    );
  }
}

type ModelDisposition = 'written' | 'unchanged' | 'excluded';

async function persistCatalog(
  deps: RefreshCatalogDeps,
  entries: readonly CatalogEntry[],
  latest: Map<string, StoredDescriptorRow>
): Promise<Result<RefreshSummary, DomainError>> {
  const counts: Record<ModelDisposition, number> = { written: 0, unchanged: 0, excluded: 0 };
  for (const entry of entries) {
    if (entry.kind === 'excluded') {
      alertExcluded(deps.telemetry, entry.modelId, entry.reason);
      counts.excluded += 1;
      continue;
    }
    const contentJson = canonicalJson(entry.content);
    if (storedContentMatches(latest.get(entry.modelId), contentJson)) {
      counts.unchanged += 1;
      continue;
    }
    const fetchedAt = deps.now();
    const upsert = await upsertCatalog(deps.db, {
      modelId: entry.modelId,
      content: entry.content,
      fetchedAt,
    });
    if (upsert.isErr()) return err(upsert.error);
    // Belt-and-suspenders: dedupe already makes every id unique here, but keep
    // the in-memory latest coherent so a repeated id compares against the
    // just-written content, never the stale pre-refresh row.
    latest.set(entry.modelId, {
      catalogId: '',
      descriptor: { ...entry.content, version: '1', fetchedAt: fetchedAt.getTime() },
    });
    counts.written += 1;
  }
  return ok({ discovered: entries.length, ...counts });
}

export function refreshCatalog(deps: RefreshCatalogDeps): ResultAsync<RefreshSummary, DomainError> {
  return jitterDelay(deps.jitter)
    .andThen(() => fetchGatewayCatalog({ baseUrl: deps.gatewayBaseUrl, fetch: deps.fetch }))
    .andThen((catalog) => {
      const entries = normalizeCatalog(catalog.models, catalog.zdrModelIds);
      return readLatestDescriptorRows(deps.db).andThen(
        (latest) => new ResultAsync(persistCatalog(deps, entries, latest))
      );
    });
}
