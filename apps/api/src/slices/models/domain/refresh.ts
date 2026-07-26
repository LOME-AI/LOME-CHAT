import { canonicalJson } from '../../../lib/idempotency/index.js';
import { ResultAsync, err, ok, okAsync } from '../../../lib/result/index.js';
import { readLatestDescriptorRows, upsertCatalog } from './catalog-store.js';
import { fetchGatewayCatalog } from './gateway-metadata.js';
import { EXCLUDE_REASONS, normalizeCatalog } from './normalize.js';
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
  /** Image-endpoints N+1 fan-out width. Callers set it from the environment
   * (`createEnvUtilities(env).isProduction ? 6 : 30`) — dev raises it so a cold
   * `catalog:refresh` fills faster; production keeps the 6-connection cap.
   * Omitted → the gateway default (the 6-connection cap). */
  readonly endpointConcurrency?: number;
}

export interface RefreshSummary {
  readonly discovered: number;
  readonly written: number;
  readonly unchanged: number;
  /** Total models excluded, summing {@link RefreshSummary.excludedByReason}. */
  readonly excluded: number;
  /** Per-reason exclusion breakdown; every {@link ExcludeReason} has an entry
   * (zero when none), so a caller can render only the non-zero categories and
   * still trust a `0` for the rest. */
  readonly excludedByReason: Record<ExcludeReason, number>;
}

/** A fresh per-reason counter with every {@link ExcludeReason} initialized to 0. */
function emptyExcludedByReason(): Record<ExcludeReason, number> {
  const counts = {} as Record<ExcludeReason, number>;
  for (const reason of EXCLUDE_REASONS) counts[reason] = 0;
  return counts;
}

function jitterDelay(jitter: RefreshJitter | undefined): ResultAsync<void, DomainError> {
  if (jitter === undefined) return okAsync();
  const delayMs = Math.floor(jitter.random() * jitter.maxMs);
  return ResultAsync.fromSafePromise(jitter.sleep(delayMs));
}

/** Content equality for skip-unchanged: the stored wire descriptor minus the
 * per-write stamp (`fetchedAt`). `version` is part of the content, so a
 * stored row on an older descriptor version never matches and is rewritten. */
function storedContentMatches(
  stored: StoredDescriptorRow | undefined,
  contentJson: string
): boolean {
  if (stored === undefined) return false;
  if (typeof stored.descriptor !== 'object' || stored.descriptor === null) return false;
  const storedContent = Object.fromEntries(
    Object.entries(stored.descriptor).filter(([key]) => key !== 'fetchedAt')
  );
  return canonicalJson(storedContent) === contentJson;
}

/** Skip the write only when BOTH the descriptor content and the popularity rank
 * are unchanged — rank lives in its own column, not the content hash, so a
 * rank-only change (identical descriptor) still needs a write. */
function shouldSkipWrite(
  stored: StoredDescriptorRow | undefined,
  contentJson: string,
  newRank: number | null
): boolean {
  return storedContentMatches(stored, contentJson) && (stored?.popularityRank ?? null) === newRank;
}

/** A fail-closed exclusion (unclassifiable modality, unknown pricing unit,
 * missing release date) is an EXPECTED catalog-exclusion condition — a model
 * "excluded with an alert" — so it is a structured Workers-Log line at `warn`,
 * never a Sentry page (founder ruling: the OpenRouter taxonomy legitimately
 * grows shapes we don't price, and paging on each every hour would be noise).
 * Expected-lifecycle / known-shape exclusions — `deprecated`,
 * `token-priced-image`, `token-priced-video`, `megapixel-priced-image`,
 * `missing-pricing` (empty-endpoint preview models), `non-zdr` (only
 * ZDR-reachable models are persisted), `non-conversational` (specialty
 * code-tooling and moderation models), and the commercial reasons
 * `zero-priced` / `below-price-floor` / `too-old` (a model that cannot be sold
 * profitably is an expected outcome, not a defect) — do not even alert; they
 * are only counted. The log messages are compile-time literals (SafeLogFields rule):
 * the model id is a field. */
function alertExcluded(telemetry: Telemetry, modelId: string, reason: ExcludeReason): void {
  if (reason === 'unknown-pricing-unit') {
    telemetry.warn('gateway model has an unknown pricing unit — model excluded', {
      modelName: modelId,
      errorCode: 'model_pricing_unit_unknown',
    });
    return;
  }
  if (reason === 'unclassifiable-modality') {
    telemetry.warn('gateway model modality has no call-shape family — model excluded', {
      modelName: modelId,
      errorCode: 'model_type_unknown',
    });
    return;
  }
  if (reason === 'missing-release-date') {
    telemetry.warn('gateway model has no release date — model excluded', {
      modelName: modelId,
      errorCode: 'model_release_date_missing',
    });
  }
}

/** A video resolution priced by SUBSTITUTION (no stated rate, the model's max
 * known rate stood in) is an EXPECTED price-fallback — a structured
 * Workers-Log line at `warn`, never a Sentry page (same founder ruling as
 * {@link alertExcluded}). One line per (model, resolution) so the substituted
 * count is visible: `SafeLogFields` has no resolution field, and inventing one
 * would leak past the allowlist. */
function alertPricingFallbacks(
  telemetry: Telemetry,
  modelId: string,
  resolutions: readonly string[] | undefined
): void {
  const count = resolutions?.length ?? 0;
  for (let index = 0; index < count; index += 1) {
    telemetry.warn('video model resolution priced by fallback — verify pricing', {
      modelName: modelId,
      errorCode: 'model_video_resolution_fallback',
    });
  }
}

type ModelDisposition = 'written' | 'unchanged' | 'excluded';

async function persistCatalog(
  deps: RefreshCatalogDeps,
  entries: readonly CatalogEntry[],
  latest: Map<string, StoredDescriptorRow>,
  rankByModelId: ReadonlyMap<string, number>
): Promise<Result<RefreshSummary, DomainError>> {
  const counts: Record<ModelDisposition, number> = { written: 0, unchanged: 0, excluded: 0 };
  const excludedByReason = emptyExcludedByReason();
  for (const entry of entries) {
    if (entry.kind === 'excluded') {
      alertExcluded(deps.telemetry, entry.modelId, entry.reason);
      counts.excluded += 1;
      excludedByReason[entry.reason] += 1;
      continue;
    }
    alertPricingFallbacks(deps.telemetry, entry.modelId, entry.pricingFallbacks);
    const contentJson = canonicalJson(entry.content);
    const newRank = rankByModelId.get(entry.modelId) ?? null;
    const stored = latest.get(entry.modelId);
    if (shouldSkipWrite(stored, contentJson, newRank)) {
      counts.unchanged += 1;
      continue;
    }
    const fetchedAt = deps.now();
    const upsert = await upsertCatalog(deps.db, {
      modelId: entry.modelId,
      content: entry.content,
      fetchedAt,
      popularityRank: newRank,
    });
    if (upsert.isErr()) return err(upsert.error);
    // Belt-and-suspenders: dedupe already makes every id unique here, but keep
    // the in-memory latest coherent so a repeated id compares against the
    // just-written content and rank, never the stale pre-refresh row.
    latest.set(entry.modelId, {
      catalogId: '',
      descriptor: { ...entry.content, fetchedAt: fetchedAt.getTime() },
      // The upsert never touches the kill switch; carry the pre-refresh value.
      adminDisabledAt: stored?.adminDisabledAt ?? null,
      popularityRank: newRank,
    });
    counts.written += 1;
  }
  return ok({ discovered: entries.length, ...counts, excludedByReason });
}

export function refreshCatalog(deps: RefreshCatalogDeps): ResultAsync<RefreshSummary, DomainError> {
  return jitterDelay(deps.jitter)
    .andThen(() =>
      fetchGatewayCatalog({
        baseUrl: deps.gatewayBaseUrl,
        fetch: deps.fetch,
        ...(deps.endpointConcurrency === undefined
          ? {}
          : { endpointConcurrency: deps.endpointConcurrency }),
      })
    )
    .andThen((catalog) => {
      const entries = normalizeCatalog(catalog.models, catalog.zdrModelIds, deps.now().getTime());
      // Rank is carried only on language models (the sorted `/models` set) and
      // rides the column, not the descriptor — collect it here for persistence.
      const rankByModelId = new Map<string, number>();
      for (const model of catalog.models) {
        if (model.source === 'language' && model.popularityRank !== undefined) {
          rankByModelId.set(model.id, model.popularityRank);
        }
      }
      return readLatestDescriptorRows(deps.db).andThen(
        (latest) => new ResultAsync(persistCatalog(deps, entries, latest, rankByModelId))
      );
    });
}
