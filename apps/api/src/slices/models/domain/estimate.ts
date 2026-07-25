import {
  ERROR_CODES,
  NO_STORAGE,
  callManifest as sharedCallManifest,
  estimateRunCeilingNanoUsd as sharedEstimateRunCeilingNanoUsd,
  evaluateManifest,
  outputTokensOf,
} from '@hushbox/shared';
import { validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import type {
  CallShapeFamily,
  CallUsage,
  DeclaredCeiling,
  EstimateResult,
  Manifest,
  NodeStorage,
  Pricing,
  Usage,
} from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * Estimate computation — the billable catalog rates are its ONLY price source,
 * so every amount here is billable with no fee math anywhere in this module.
 * Estimates feed admission holds and the settlement's `isEstimated` charge; the
 * authoritative charged cost lives in billing's settlement flow and is never
 * consulted here. Every cost formula (per-token sums, media rate × units,
 * the ceiling multiplier) lives ONCE in the shared estimator core
 * (`@hushbox/shared/estimate`); this module is the thin server adapter that
 * drives the core's `callManifest` / `estimateRunCeilingNanoUsd` /
 * `buildMediaLineItems` and translates the core's `EstimateResult` union into
 * the domain `Result` channel. A rate the usage needs but the pricing lacks is a
 * validation error, never a silent zero.
 */

// The token/media usage, declared-ceiling, and per-node storage shapes are the
// shared estimator core's — re-exported so the models slice's callers keep their
// `./estimate.js` import site.
export type { CallUsage, DeclaredCeiling, NodeStorage } from '@hushbox/shared';
// The catalog `Pricing` → named-rate mapping is the shared core's single home;
// re-exported for the slice's callers (trial eligibility, candidate builder).
export { ratesFromPricing } from '@hushbox/shared';

/** The core's typed pricing failure, surfaced through the domain `Result` channel. */
function fromEstimate<T>(result: EstimateResult<T>): Result<T, DomainError> {
  return result.ok ? ok(result.value) : err(validationError(result.error.detail));
}

/**
 * One call's billable {@link Manifest} from the shared core, on the domain
 * `Result` channel. The token path prices per-model input/output rates plus an
 * output-storage rate item; the media path prices `rate × units` plus a
 * media-storage item. With {@link NO_STORAGE} the storage items are zero/discarded
 * and only the provider cost survives (the billable-call and provider-ceiling
 * pricers).
 */
function callManifest(
  pricing: Pricing,
  usage: CallUsage,
  storage: NodeStorage
): Result<Manifest, DomainError> {
  return fromEstimate(sharedCallManifest(pricing, usage, storage));
}

/**
 * One call's BILLABLE cost from the billable catalog rates — tokens or media
 * units. Folds ONLY the provider line items via the shared `evaluateManifest`
 * (storage is pass-through, excluded): this is the customer-facing model cost
 * as-is — settlement's estimate-path charges bill it directly, with no
 * further fee application anywhere downstream.
 */
export function callBillableNanoUsd(
  pricing: Pricing,
  usage: CallUsage
): Result<bigint, DomainError> {
  return callManifest(pricing, usage, NO_STORAGE).map((manifest) =>
    evaluateManifest(manifest, outputTokensOf(usage), { scope: 'provider-only' })
  );
}

/** Descriptor pricing key for image models: flat nano-USD per output image. */
const IMAGE_RATE_KEY = 'perImage';

/** Descriptor pricing key for video models: nano-USD/second matrix by resolution. */
const VIDEO_RATE_KEY = 'perSecondByResolution';

/**
 * Deterministic media pricing inputs from a call's request parameters. Image
 * and video prices are computable up front (catalog rate × requested units),
 * so the SAME derivation feeds the admission ceiling and the settlement
 * charge. Fail-closed: a missing/invalid parameter or a non-media family is a
 * validation error — an unpriceable media call must refuse before any
 * provider spend, never fail after it.
 */
export function mediaCallUsageFor(
  family: CallShapeFamily | undefined,
  params: Record<string, unknown>
): Result<CallUsage, DomainError> {
  if (family === 'image') return imageCallUsage(params);
  if (family === 'video') return videoCallUsage(params);
  return err(validationError('Deterministic media pricing applies only to image/video calls'));
}

/**
 * One generation call produces exactly one artifact (founder ruling). A
 * multi-artifact request (`n > 1`) is refused fail-closed: admission would
 * under-reserve by n× and the node accumulator persists a single artifact, so
 * pricing n would bill artifacts the run never keeps.
 */
function requireSingleArtifact(params: Record<string, unknown>): Result<void, DomainError> {
  const n = params['n'] ?? 1;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    return err(validationError("Media call parameter 'n' must be a positive integer"));
  }
  if (n > 1) {
    return err(
      validationError("Media call parameter 'n' must be 1: one generation call, one artifact")
    );
  }
  return ok();
}

function imageCallUsage(params: Record<string, unknown>): Result<CallUsage, DomainError> {
  return requireSingleArtifact(params).map(() => ({
    kind: 'media' as const,
    rateKey: IMAGE_RATE_KEY,
    units: 1,
  }));
}

function videoCallUsage(params: Record<string, unknown>): Result<CallUsage, DomainError> {
  const singleArtifact = requireSingleArtifact(params);
  if (singleArtifact.isErr()) return err(singleArtifact.error);
  const resolution = params['resolution'];
  if (typeof resolution !== 'string' || resolution.length === 0) {
    return err(
      validationError(
        "Video call requires a 'resolution' parameter to price",
        undefined,
        ERROR_CODES.UNSUPPORTED_RESOLUTION
      )
    );
  }
  const durationSeconds = params['durationSeconds'];
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 1
  ) {
    return err(
      validationError(
        "Video call requires a positive integer 'durationSeconds' to price",
        undefined,
        ERROR_CODES.UNSUPPORTED_DURATION
      )
    );
  }
  return ok({
    kind: 'media',
    rateKey: VIDEO_RATE_KEY,
    dimensionKey: resolution,
    units: durationSeconds,
  });
}

/**
 * A media call's BILLABLE deterministic price from the billable catalog rates
 * and request parameters. Exact by construction for image (charged as-is at
 * settlement); for video it is the admission ceiling, the
 * pathological-missing-cost fallback, and the inline-cost sanity bound. A
 * resolution absent from the pricing matrix fails closed inside the rate
 * lookup.
 */
export function priceMediaBillableNanoUsd(
  pricing: Pricing,
  family: CallShapeFamily | undefined,
  params: Record<string, unknown>
): Result<bigint, DomainError> {
  return mediaCallUsageFor(family, params).andThen((usage) => callBillableNanoUsd(pricing, usage));
}

/**
 * Adapts observed inference `Usage` to the token-priced `CallUsage` the base
 * pricer takes. `reasoningTokens` is a SUBSET of `outputTokens` — the provider
 * reports completion tokens (text + reasoning) as the output total and the
 * reasoning count as a breakdown of it — so pricing `outputTokens` at the
 * output rate already bills reasoning; adding it again would double-count.
 * `cachedInputTokens` is likewise a subset of `inputTokens` already counted at
 * the full input rate (the catalog has no cache rate), so it is left alone: a
 * conservative over-estimate, never an under-charge.
 */
function callUsageFromUsage(usage: Usage): CallUsage {
  return {
    kind: 'tokens',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

/**
 * One call's BILLABLE estimate from observed `Usage` — the amount a model
 * binding's `price` returns. Settlement charges it directly on the
 * estimate-fallback path; no fee lands anywhere downstream. A `0n` result is
 * a legal no-charge (settlement is never balance-guarded).
 */
export function priceUsageBillableNanoUsd(
  pricing: Pricing,
  usage: Usage
): Result<bigint, DomainError> {
  return callBillableNanoUsd(pricing, callUsageFromUsage(usage));
}

/**
 * The admission estimate: the per-call ceiling cost priced across the run's
 * declared worst case, via the shared core `estimateRunCeilingNanoUsd` (the
 * billable per-call ceiling multiplied by width × steps × iterations),
 * surfaced on the domain `Result` channel. With `storage` present
 * the node's output-storage (token nodes) or media-storage (media nodes) rides
 * the ceiling, unmarked; absent, only provider cost is priced. A zero ceiling is
 * rejected — it would place a zero admission hold (free admission), which is
 * always a caller bug, never a legitimate run.
 */
export function estimateRunCeilingNanoUsd(
  pricing: Pricing,
  usage: CallUsage,
  ceiling: DeclaredCeiling,
  storage?: NodeStorage
): Result<bigint, DomainError> {
  return fromEstimate(sharedEstimateRunCeilingNanoUsd(pricing, usage, ceiling, storage));
}
