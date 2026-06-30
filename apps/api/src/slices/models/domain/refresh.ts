import { callShapeFamilyFor } from '@hushbox/shared';
import { canonicalJson } from '../../../lib/idempotency/index.js';
import { ResultAsync, err, ok, okAsync } from '../../../lib/result/index.js';
import { insertCatalogVersion, readLatestDescriptorRows, readOverrides } from './catalog-store.js';
import { fetchGatewayCatalog } from './gateway-metadata.js';
import { normalizeModel } from './normalize.js';
import { isZdrVerificationAged } from './overrides.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { StoredDescriptorRow } from './catalog-store.js';
import type { GatewayCatalog } from './gateway-metadata.js';
import type { ModelOverride } from './overrides.js';
import type { Result } from '../../../lib/result/index.js';

/**
 * The catalog refresh: two-tier gateway fetch, normalize against overrides,
 * persist versioned descriptors skip-unchanged. Designed for an hourly cron
 * trigger (the caller passes `jitter` so a fleet of triggers spreads out);
 * an internal consumer, so no Idempotency-Key header — every write goes
 * through `idempotent.byUpsert` on UNIQUE(model_id, version), which also
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

function alertInvalidOverrides(telemetry: Telemetry, invalidModelIds: readonly string[]): void {
  for (const modelId of invalidModelIds) {
    telemetry.warn('model override row failed contract validation — supplement ignored', {
      modelName: modelId,
      errorCode: 'model_override_invalid',
    });
  }
}

function alertAgedZdrVerification(
  telemetry: Telemetry,
  now: Date,
  family: 'image' | 'video',
  override: ModelOverride
): void {
  if (override.zdrVerifiedAt !== null && isZdrVerificationAged(override.zdrVerifiedAt, now)) {
    // Exposure-relevant: ZDR staleness rides the error-capture channel
    // (Sentry-visible), not just structured logs nothing alerts on.
    const errorCode =
      family === 'image'
        ? ('model_zdr_verification_aged_image' as const)
        : ('model_zdr_verification_aged_video' as const);
    telemetry.error('model ZDR verification aged past the 90-day window', {
      modelName: override.modelId,
      errorCode,
    });
    telemetry.captureError(
      new Error('model ZDR verification aged past the 90-day window'),
      errorCode
    );
  }
}

type ModelDisposition = 'written' | 'unchanged' | 'excluded';

interface ModelPersistContext {
  readonly override: ModelOverride | undefined;
  readonly stored: StoredDescriptorRow | undefined;
}

async function persistModel(
  deps: RefreshCatalogDeps,
  zdrProviders: ReadonlySet<string>,
  model: GatewayCatalog['models'][number],
  { override, stored }: ModelPersistContext
): Promise<Result<ModelDisposition, DomainError>> {
  const outcome = normalizeModel(model, zdrProviders, override);
  if (outcome.kind === 'excluded') {
    // An unknown gateway type is an alert, never a crash — and it rides the
    // error-capture channel (Sentry-visible), not just structured logs.
    deps.telemetry.error('gateway model type has no call-shape family — model excluded', {
      modelName: outcome.modelId,
      errorCode: 'model_type_unknown',
    });
    deps.telemetry.captureError(
      new Error('gateway model type has no call-shape family — model excluded'),
      'model_type_unknown'
    );
    return ok('excluded');
  }
  // The aging alert must cover exactly the models the dated-ZDR exposure
  // gate gates, so its family comes from the canonical descriptor→family
  // derivation — never `outcome.family`, which is modelType-derived and
  // calls a media-only-output gateway entry "language".
  const exposureFamily = callShapeFamilyFor(outcome.content.outputs);
  if ((exposureFamily === 'image' || exposureFamily === 'video') && override !== undefined) {
    alertAgedZdrVerification(deps.telemetry, deps.now(), exposureFamily, override);
  }
  if (storedContentMatches(stored, canonicalJson(outcome.content))) return ok('unchanged');
  const insert = await insertCatalogVersion(deps.db, {
    modelId: model.id,
    version: (stored?.version ?? 0) + 1,
    content: outcome.content,
    fetchedAt: deps.now(),
  });
  if (insert.isErr()) return err(insert.error);
  // A lost insert race means a concurrent refresh already wrote this exact
  // version — converged, not written.
  return ok(insert.value ? 'written' : 'unchanged');
}

async function persistCatalog(
  deps: RefreshCatalogDeps,
  catalog: GatewayCatalog,
  overrides: ReadonlyMap<string, ModelOverride>,
  latest: ReadonlyMap<string, StoredDescriptorRow>
): Promise<Result<RefreshSummary, DomainError>> {
  const counts: Record<ModelDisposition, number> = { written: 0, unchanged: 0, excluded: 0 };
  for (const model of catalog.models) {
    const disposition = await persistModel(deps, catalog.zdrProviders, model, {
      override: overrides.get(model.id),
      stored: latest.get(model.id),
    });
    if (disposition.isErr()) return err(disposition.error);
    counts[disposition.value] += 1;
  }
  return ok({ discovered: catalog.models.length, ...counts });
}

export function refreshCatalog(deps: RefreshCatalogDeps): ResultAsync<RefreshSummary, DomainError> {
  return jitterDelay(deps.jitter)
    .andThen(() => fetchGatewayCatalog({ baseUrl: deps.gatewayBaseUrl, fetch: deps.fetch }))
    .andThen((catalog) =>
      readOverrides(deps.db).andThen((overridesRead) => {
        alertInvalidOverrides(deps.telemetry, overridesRead.invalidModelIds);
        return readLatestDescriptorRows(deps.db).andThen(
          (latest) =>
            new ResultAsync(persistCatalog(deps, catalog, overridesRead.overrides, latest))
        );
      })
    );
}
