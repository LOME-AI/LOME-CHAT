import { match } from 'ts-pattern';
import {
  ERROR_CODES,
  WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL,
  buildMediaLineItems,
  evaluateManifest,
  priceRequest,
  reservationCeiling,
} from '@hushbox/shared';
import { applyMarkup } from '../../billing/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { Result, err, ok } from '../../../lib/result/index.js';
import type {
  CallShapeFamily,
  EstimateResult,
  Manifest,
  MediaBillable,
  MediaRateKey,
  ModelRatesNano,
  Pricing,
  ReservationCeilingInput,
  Usage,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The worst-case pre-flight web-search reservation for ONE model call that
 * enabled the search tool: `MAX_SEARCH_TOOL_CALLS` invocations at the
 * conservative per-call rate, marked up once. Single-sourced from the shared
 * estimator core's `WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL` (the nano-USD
 * bigint analogue of legacy `worstCaseSearchCost()`), so the reservation can
 * never drift from the runtime search cap. Search cost is a provider cost (not
 * pass-through storage), so it takes the markup like any inference charge. The
 * run's admission ceiling adds this on top of a web-search node's token ceiling
 * so a turn that cannot afford the worst-case search spend is refused up front,
 * rather than admitted and killed mid-run by the cost circuit. Settlement bills
 * the provider's actual search cost (folded into `usage.cost`), never this
 * reservation.
 */
export const WORST_CASE_SEARCH_RESERVATION_NANO_USD: bigint = applyMarkup(
  WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL
);

/**
 * Estimate computation — catalog rates are its ONLY price source. Estimates
 * feed admission holds and the settlement's `isEstimated` charge; the
 * authoritative charged cost lives in billing's settlement flow and is never
 * consulted here. Every cost formula (per-token sums, media rate × units, the
 * markup fold, the ceiling multiplier) lives ONCE in the shared estimator core
 * (`@hushbox/shared/estimate`); this module is the thin server adapter that maps
 * the catalog `Pricing` to the core's `ModelRatesNano`, drives the core's
 * `priceRequest` / `buildMediaLineItems` / `reservationCeiling`, and translates
 * the core's `EstimateResult` union into the domain `Result` channel. A rate the
 * usage needs but the pricing lacks is a validation error, never a silent zero.
 */

export type CallUsage =
  | { readonly kind: 'tokens'; readonly inputTokens: number; readonly outputTokens: number }
  | {
      readonly kind: 'media';
      /** The catalog pricing key to charge against (`perImage`, `perSecond`, or the matrix). */
      readonly rateKey: MediaRateKey;
      /** Required when the rate is a per-resolution matrix. */
      readonly dimensionKey?: string;
      readonly units: number;
    };

/** The declared ceiling admission prices: max width × steps × iterations. */
export interface DeclaredCeiling {
  readonly maxFanOutWidth: number;
  readonly maxSteps: number;
  readonly maxIterations: number;
}

/**
 * The per-node storage inputs a persisting turn adds to its ceiling. Optional on
 * the run ceiling pricer: absent ⇒ provider cost only (the pre-storage default
 * for general workflows and the settlement-side base pricers). Input storage is
 * NOT here — it is charged once at the definition level by the run estimator, not
 * per node.
 */
export interface NodeStorage {
  /** Output-storage chars-per-token for the tier (answer-producing token nodes). */
  readonly outputCharsPerToken: number;
  /** Estimated encrypted output bytes (media nodes). */
  readonly mediaStorageBytes: number;
}

/** Storage OFF: the base/ceiling pricers price provider cost only. */
const NO_STORAGE: NodeStorage = { outputCharsPerToken: 1, mediaStorageBytes: 0 };

/** The core's typed pricing failure, surfaced through the domain `Result` channel. */
function fromEstimate<T>(result: EstimateResult<T>): Result<T, DomainError> {
  return result.ok ? ok(result.value) : err(validationError(result.error.detail));
}

/**
 * Reads the catalog `Pricing` bag into the core's named-rate shape. A missing or
 * wrong-typed key is simply left off — the core fails closed on the specific rate
 * a request needs, so an omitted rate becomes a precise pricing error there rather
 * than a silent zero here. Shared across the slice's estimators so the mapping
 * lives once (the classifier and trial pricers read the same named rates).
 */
export function ratesFromPricing(pricing: Pricing): ModelRatesNano {
  const rates: {
    inputPerToken?: bigint;
    outputPerToken?: bigint;
    perImage?: bigint;
    perSecond?: bigint;
    perSecondByResolution?: Readonly<Record<string, bigint>>;
  } = {};
  const input = pricing['inputPerToken'];
  if (typeof input === 'bigint') rates.inputPerToken = input;
  const output = pricing['outputPerToken'];
  if (typeof output === 'bigint') rates.outputPerToken = output;
  const perImage = pricing['perImage'];
  if (typeof perImage === 'bigint') rates.perImage = perImage;
  const perSecond = pricing['perSecond'];
  if (typeof perSecond === 'bigint') rates.perSecond = perSecond;
  const matrix = pricing['perSecondByResolution'];
  if (matrix !== undefined && typeof matrix !== 'bigint') rates.perSecondByResolution = matrix;
  return rates;
}

function countToBigInt(value: number, label: string): Result<bigint, DomainError> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return err(validationError(`Estimate ${label} must be a non-negative integer`));
  }
  return ok(BigInt(value));
}

/**
 * One call's pre-markup {@link Manifest} from the core. The token path prices
 * per-model input/output rates plus an output-storage rate item
 * (`storage.outputCharsPerToken`); the media path prices `rate × units` plus a
 * media-storage item (`storage.mediaStorageBytes`). Input storage is always
 * zero here (`inputChars: 0`) — it is a definition-level, not per-call, cost.
 * With {@link NO_STORAGE} the storage items are zero/discarded and only the
 * provider cost survives (the base and provider-ceiling pricers).
 */
function callManifest(
  pricing: Pricing,
  usage: CallUsage,
  storage: NodeStorage
): Result<Manifest, DomainError> {
  const rates = ratesFromPricing(pricing);
  return match(usage)
    .with({ kind: 'tokens' }, (tokens) =>
      Result.combine([
        countToBigInt(tokens.inputTokens, 'inputTokens'),
        countToBigInt(tokens.outputTokens, 'outputTokens'),
      ]).andThen(([inputTokens]) =>
        fromEstimate(
          priceRequest({
            models: [{ pricing: rates }],
            inputTokens,
            inputChars: 0,
            outputCharsPerToken: storage.outputCharsPerToken,
          })
        )
      )
    )
    .with({ kind: 'media' }, (media) => {
      const billable: MediaBillable = {
        rateKey: media.rateKey,
        ...(media.dimensionKey === undefined ? {} : { dimensionKey: media.dimensionKey }),
        units: media.units,
        storageBytes: storage.mediaStorageBytes,
      };
      return fromEstimate(
        buildMediaLineItems({
          models: [{ pricing: rates }],
          inputTokens: 0n,
          inputChars: 0,
          outputCharsPerToken: storage.outputCharsPerToken,
          media: billable,
        })
      ).map((items) => ({ items }));
    })
    .exhaustive();
}

function outputTokensOf(usage: CallUsage): bigint {
  return usage.kind === 'tokens' ? BigInt(usage.outputTokens) : 0n;
}

/**
 * One call's BASE (pre-markup) cost from catalog rates — tokens or media units.
 * Folds ONLY the marked-up (provider) line items via the shared
 * `evaluateManifest` (storage is pass-through, excluded): this recovers the
 * provider base settlement charges and marks up exactly once downstream in
 * `chargeWithinTx`; `estimateCallNanoUsd` and the run-ceiling estimate wrap this
 * with `applyMarkup` for their customer-facing amounts.
 */
export function callBaseNanoUsd(pricing: Pricing, usage: CallUsage): Result<bigint, DomainError> {
  return callManifest(pricing, usage, NO_STORAGE).map((manifest) =>
    evaluateManifest(manifest, outputTokensOf(usage), { marksUpOnly: true })
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
 * A media call's BASE (pre-markup) deterministic price from catalog rates and
 * request parameters. Exact by construction for image (charged as-is at
 * settlement); for video it is the admission ceiling, the
 * pathological-missing-cost fallback, and the inline-cost sanity bound. A
 * resolution absent from the pricing matrix fails closed inside the rate
 * lookup.
 */
export function priceMediaBaseNanoUsd(
  pricing: Pricing,
  family: CallShapeFamily | undefined,
  params: Record<string, unknown>
): Result<bigint, DomainError> {
  return mediaCallUsageFor(family, params).andThen((usage) => callBaseNanoUsd(pricing, usage));
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
 * One call's BASE (pre-markup) estimate from observed `Usage` — the amount a
 * model binding's `price` returns. The 15% markup lands exactly once downstream
 * in settlement's `chargeWithinTx`, never here.
 */
export function priceUsageBaseNanoUsd(pricing: Pricing, usage: Usage): Result<bigint, DomainError> {
  return callBaseNanoUsd(pricing, callUsageFromUsage(usage));
}

/**
 * One call's customer-facing estimate: catalog base cost with the markup.
 * This is the settlement-side estimate over observed usage, where a `0n`
 * result is a legal no-charge (settlement is never balance-guarded).
 * Admission callers must use `estimateRunCeilingNanoUsd`, which rejects a
 * zero ceiling — a zero admission hold is a caller bug.
 */
export function estimateCallNanoUsd(
  pricing: Pricing,
  usage: CallUsage
): Result<bigint, DomainError> {
  return callBaseNanoUsd(pricing, usage).map((base) => applyMarkup(base));
}

/**
 * Builds the core's `ReservationCeilingInput` from the declared ceiling and a
 * call's output-token count, validating each dimension is a positive integer.
 * The core reducer throws on an invalid multiplier (a caller invariant break);
 * validating here keeps a bad declaration on the domain `Result` channel — a
 * refused run, never a thrown defect.
 */
function ceilingInput(
  usage: CallUsage,
  ceiling: DeclaredCeiling
): Result<ReservationCeilingInput, DomainError> {
  const dimensions: readonly (readonly [string, number])[] = [
    ['maxFanOutWidth', ceiling.maxFanOutWidth],
    ['maxSteps', ceiling.maxSteps],
    ['maxIterations', ceiling.maxIterations],
  ];
  for (const [label, value] of dimensions) {
    if (!Number.isSafeInteger(value) || value < 1) {
      return err(validationError(`Estimate ceiling ${label} must be a positive integer`));
    }
  }
  return ok({
    outputTokenCeiling: outputTokensOf(usage),
    fanOutWidth: ceiling.maxFanOutWidth,
    maxSteps: ceiling.maxSteps,
    maxIterations: ceiling.maxIterations,
  });
}

/** A manifest reduced to its marked-up (provider) items — storage stripped. */
function marksUpOnly(manifest: Manifest): Manifest {
  return { items: manifest.items.filter((item) => item.marksUp) };
}

/**
 * The admission estimate: the per-call ceiling cost priced across the run's
 * declared worst case, via the core `reservationCeiling` reducer (markup applied
 * once to the marked-up subtotal, then multiplied by width × steps ×
 * iterations). With `storage` present the node's output-storage (token nodes) or
 * media-storage (media nodes) rides the ceiling, unmarked; absent, only provider
 * cost is priced. A zero ceiling is rejected — it would place a zero admission
 * hold (free admission), which is always a caller bug, never a legitimate run.
 */
export function estimateRunCeilingNanoUsd(
  pricing: Pricing,
  usage: CallUsage,
  ceiling: DeclaredCeiling,
  storage?: NodeStorage
): Result<bigint, DomainError> {
  return Result.combine([
    callManifest(pricing, usage, storage ?? NO_STORAGE),
    ceilingInput(usage, ceiling),
  ]).andThen(([manifest, input]) => {
    const priced = storage === undefined ? marksUpOnly(manifest) : manifest;
    const amount = reservationCeiling(priced, input);
    if (amount === 0n) {
      return err(validationError('Estimate run ceiling must be a positive amount'));
    }
    return ok(amount);
  });
}
